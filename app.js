// Main entry point for the multi‑tenant form SaaS application.
//
// This Express application uses MongoDB (via Mongoose) to store users,
// forms and submissions. There are two primary roles:
//  - company: can register/login, create forms, view submissions.
//  - client: fills out forms; no authentication required.
//
// To run this app locally:
//   1. Create a MongoDB Atlas cluster and get a connection URI.
//   2. Create a `.env` file at the root with at least:
//        MONGODB_URI=mongodb+srv://<username>:<password>@cluster-url/dbname
//        SESSION_SECRET=yourSecretString
//   3. Run `npm install` to install dependencies.
//   4. Start the server with `npm start`.

const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const dotenv = require('dotenv');

// Load environment variables from .env if present
dotenv.config();

// Constants
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/formsaas';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';

// Initialise Express app
const app = express();

// Connect to MongoDB
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('MongoDB connection error:', err);
});

// Define Mongoose schemas and models
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['company'], default: 'company' },
  companyName: { type: String, required: true },
  logoPath: { type: String } // optional path to logo image
});
const User = mongoose.model('User', userSchema);

// Each form belongs to a company user and defines its fields and template
const formSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  fields: [{ name: String, type: String, required: false }],
  template: { type: String, default: 'default' },
  allowFile: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const Form = mongoose.model('Form', formSchema);

// Each submission stores data for a specific form; filePath stores uploaded document (e.g. photo)
const submissionSchema = new mongoose.Schema({
  form: { type: mongoose.Schema.Types.ObjectId, ref: 'Form', required: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  filePath: { type: String },
  submittedAt: { type: Date, default: Date.now }
});
const Submission = mongoose.model('Submission', submissionSchema);

// Configure storage for uploaded files (both logos and attachments)
const uploadDir = path.join(__dirname, 'public', 'uploads');
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: MONGODB_URI,
    collectionName: 'sessions'
  }),
  cookie: {
    maxAge: 1000 * 60 * 60 * 24, // 1 day
    httpOnly: true
    // In production, set secure: true for HTTPS
  }
}));

// Middleware to expose user to templates
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user;
  next();
});

// Helper: ensure user is authenticated (company)
function requireCompany(req, res, next) {
  if (req.session.user && req.session.user.role === 'company') {
    return next();
  }
  res.redirect('/login');
}

// Routes

// Home page: list all companies and their public forms
app.get('/', async (req, res) => {
  try {
    // Fetch companies
    const companies = await User.find({ role: 'company' });
    // Fetch forms grouped by company
    const forms = await Form.find().populate('company');
    res.render('index', { companies, forms });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur du serveur');
  }
});

// Registration page for companies
app.get('/register', (req, res) => {
  res.render('register', { error: null });
});

// Handle company registration
app.post('/register', upload.single('logo'), async (req, res) => {
  const { username, password, companyName } = req.body;
  if (!username || !password || !companyName) {
    return res.render('register', { error: 'Tous les champs sont obligatoires.' });
  }
  try {
    const existing = await User.findOne({ username });
    if (existing) {
      return res.render('register', { error: 'Nom d’utilisateur déjà utilisé.' });
    }
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const logoPath = req.file ? '/uploads/' + req.file.filename : undefined;
    const user = new User({ username, passwordHash, companyName, logoPath });
    await user.save();
    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.render('register', { error: 'Erreur lors de l’inscription.' });
  }
});

// Login page
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// Handle login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.render('login', { error: 'Identifiants invalides.' });
    }
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.render('login', { error: 'Identifiants invalides.' });
    }
    req.session.user = { id: user._id.toString(), role: user.role, companyName: user.companyName };
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Erreur lors de la connexion.' });
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Dashboard for companies
app.get('/dashboard', requireCompany, async (req, res) => {
  try {
    const forms = await Form.find({ company: req.session.user.id });
    res.render('dashboard', { forms });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur du serveur');
  }
});

// Create new form page
app.get('/form/new', requireCompany, (req, res) => {
  res.render('createForm', { error: null });
});

// Handle new form creation
app.post('/form/new', requireCompany, async (req, res) => {
  const { title, fieldNames, fieldTypes, template, allowFile } = req.body;
  if (!title) {
    return res.render('createForm', { error: 'Le titre est obligatoire.' });
  }
  try {
    const fields = [];
    // fieldNames and fieldTypes are arrays if multiple fields, or strings if one field
    if (Array.isArray(fieldNames)) {
      for (let i = 0; i < fieldNames.length; i++) {
        if (fieldNames[i]) {
          fields.push({ name: fieldNames[i], type: fieldTypes[i] || 'text' });
        }
      }
    } else if (fieldNames) {
      fields.push({ name: fieldNames, type: fieldTypes || 'text' });
    }
    const form = new Form({
      company: req.session.user.id,
      title,
      fields,
      template: template || 'default',
      allowFile: allowFile === 'on'
    });
    await form.save();
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.render('createForm', { error: 'Erreur lors de la création du formulaire.' });
  }
});

// Edit form page
app.get('/form/edit/:id', requireCompany, async (req, res) => {
  const formId = req.params.id;
  try {
    const form = await Form.findById(formId);
    if (!form || form.company.toString() !== req.session.user.id) {
      return res.status(403).send('Accès refusé');
    }
    res.render('editForm', { form, error: null });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur du serveur');
  }
});

// Handle form update
app.post('/form/edit/:id', requireCompany, async (req, res) => {
  const formId = req.params.id;
  const { title, fieldNames, fieldTypes, template, allowFile } = req.body;
  try {
    const form = await Form.findById(formId);
    if (!form || form.company.toString() !== req.session.user.id) {
      return res.status(403).send('Accès refusé');
    }
    form.title = title;
    // Rebuild fields array
    const fields = [];
    if (Array.isArray(fieldNames)) {
      for (let i = 0; i < fieldNames.length; i++) {
        if (fieldNames[i]) {
          fields.push({ name: fieldNames[i], type: fieldTypes[i] || 'text' });
        }
      }
    } else if (fieldNames) {
      fields.push({ name: fieldNames, type: fieldTypes || 'text' });
    }
    form.fields = fields;
    form.template = template || 'default';
    form.allowFile = allowFile === 'on';
    await form.save();
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur lors de la mise à jour du formulaire');
  }
});

// View submissions for a form
app.get('/form/submissions/:id', requireCompany, async (req, res) => {
  const formId = req.params.id;
  try {
    const form = await Form.findById(formId);
    if (!form || form.company.toString() !== req.session.user.id) {
      return res.status(403).send('Accès refusé');
    }
    const submissions = await Submission.find({ form: formId });
    res.render('submissions', { form, submissions });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur du serveur');
  }
});

// Public form page (client view)
app.get('/form/:id', async (req, res) => {
  const formId = req.params.id;
  try {
    const form = await Form.findById(formId).populate('company');
    if (!form) {
      return res.status(404).send('Formulaire introuvable');
    }
    res.render('form', { form });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur du serveur');
  }
});

// Handle form submission (client)
app.post('/form/:id', upload.single('attachment'), async (req, res) => {
  const formId = req.params.id;
  try {
    const form = await Form.findById(formId);
    if (!form) {
      return res.status(404).send('Formulaire introuvable');
    }
    // Build data object from form fields
    const data = {};
    form.fields.forEach(field => {
      const value = req.body[field.name] || '';
      data[field.name] = value;
    });
    // Save submission
    const filePath = req.file ? '/uploads/' + req.file.filename : undefined;
    const submission = new Submission({ form: formId, data, filePath });
    await submission.save();
    res.render('thanks');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erreur lors de la soumission du formulaire');
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});