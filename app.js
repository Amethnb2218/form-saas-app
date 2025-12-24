// Main entry point for the multi-tenant form SaaS application.

const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const dotenv = require('dotenv');
const expressLayouts = require('express-ejs-layouts');

dotenv.config();

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/formsaas';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_this_secret';

const app = express();

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.locals.title = res.locals.title || 'Form SaaS';
  res.locals.error = res.locals.error ?? null;
  next();
});

// MongoDB
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error(err));

// Models
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['company'], default: 'company' },
  companyName: { type: String, required: true },
  logoPath: String
});
const User = mongoose.model('User', userSchema);

const formSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  fields: [{ name: String, type: String }],
  template: { type: String, default: 'default' },
  allowFile: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const Form = mongoose.model('Form', formSchema);

const submissionSchema = new mongoose.Schema({
  form: { type: mongoose.Schema.Types.ObjectId, ref: 'Form', required: true },
  data: mongoose.Schema.Types.Mixed,
  filePath: String,
  submittedAt: { type: Date, default: Date.now }
});
const Submission = mongoose.model('Submission', submissionSchema);

// Upload
const uploadDir = path.join(__dirname, 'public/uploads');
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) =>
    cb(null, Date.now() + '-' + Math.random() + '-' + file.originalname)
});
const upload = multer({ storage });

// Session
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: MONGODB_URI }),
    cookie: { maxAge: 86400000 }
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user;
  next();
});

function requireCompany(req, res, next) {
  if (req.session.user?.role === 'company') return next();
  res.redirect('/login');
}

// Routes
app.get('/', async (req, res) => {
  const companies = await User.find();
  const forms = await Form.find().populate('company');
  res.render('index', { title: 'Accueil', companies, forms });
});

app.get('/register', (req, res) =>
  res.render('register', { title: 'Inscription', error: null })
);

app.post('/register', upload.single('logo'), async (req, res) => {
  const { username, password, companyName } = req.body;
  if (!username || !password || !companyName)
    return res.render('register', { title: 'Inscription', error: 'Champs requis' });

  const existing = await User.findOne({ username });
  if (existing)
    return res.render('register', { title: 'Inscription', error: 'Utilisateur existe déjà' });

  const passwordHash = await bcrypt.hash(password, 12);
  const logoPath = req.file ? '/uploads/' + req.file.filename : undefined;

  await new User({ username, passwordHash, companyName, logoPath }).save();
  res.redirect('/login');
});

app.get('/login', (req, res) =>
  res.render('login', { title: 'Connexion', error: null })
);

app.post('/login', async (req, res) => {
  const user = await User.findOne({ username: req.body.username });
  if (!user || !(await bcrypt.compare(req.body.password, user.passwordHash)))
    return res.render('login', { title: 'Connexion', error: 'Identifiants invalides' });

  req.session.user = { id: user._id, role: user.role, companyName: user.companyName };
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/dashboard', requireCompany, async (req, res) => {
  const forms = await Form.find({ company: req.session.user.id });
  res.render('dashboard', { title: 'Tableau de bord', forms });
});

app.get('/form/new', requireCompany, (req, res) =>
  res.render('createForm', { title: 'Nouveau formulaire', error: null })
);

app.post('/form/new', requireCompany, async (req, res) => {
  const fields = [];
  const { fieldNames, fieldTypes } = req.body;

  if (Array.isArray(fieldNames)) {
    fieldNames.forEach((n, i) => n && fields.push({ name: n, type: fieldTypes[i] }));
  } else if (fieldNames) {
    fields.push({ name: fieldNames, type: fieldTypes });
  }

  await new Form({
    company: req.session.user.id,
    title: req.body.title,
    fields,
    template: req.body.template || 'default',
    allowFile: req.body.allowFile === 'on'
  }).save();

  res.redirect('/dashboard');
});

app.get('/form/edit/:id', requireCompany, async (req, res) => {
  const form = await Form.findById(req.params.id);
  if (!form || form.company.toString() !== req.session.user.id)
    return res.status(403).send('Accès refusé');

  res.render('editForm', { title: 'Modifier le formulaire', form, error: null });
});

app.listen(PORT, () =>
  console.log(`Server listening on port ${PORT}`)
);
