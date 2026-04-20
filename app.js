// Main entry point for the multi-tenant form SaaS application.

const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const selfsigned = require('selfsigned');
const dotenv = require('dotenv');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const expressLayouts = require('express-ejs-layouts');

dotenv.config();

function parseEnvBoolean(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function normalizeText(value) {
  return String(value || '').trim();
}

function toSafeKey(value, fallback) {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_\-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
}

function parseBoolean(value) {
  return value === true || value === 'true' || value === 'on';
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isValidObjectId(value) {
  return mongoose.Types.ObjectId.isValid(value);
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function discardUploadedFile(file) {
  if (file?.path) {
    fs.unlink(file.path, () => {});
  }
}

function discardStoredFilePath(filePath) {
  if (!filePath) {
    return;
  }

  const safeRelativePath = String(filePath).replace(/^\/+/, '');
  discardUploadedFile({ path: path.join(__dirname, 'public', safeRelativePath) });
}

function csvEscape(value) {
  const raw = String(value ?? '');
  if (/[",\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function sanitizeFileName(value, fallback) {
  const safe = toSafeKey(value, fallback).replace(/[^a-z0-9\-_]/gi, '-');
  return safe || fallback;
}

const PORT = Number(process.env.PORT) || 3000;
const EXPLICIT_MONGODB_URI = normalizeText(process.env.MONGODB_URI);
const DEFAULT_LOCAL_MONGODB_URI = 'mongodb://127.0.0.1:27017/formsaas';
const MONGODB_URI = EXPLICIT_MONGODB_URI || DEFAULT_LOCAL_MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev_only_change_me';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const MAX_UPLOAD_SIZE_MB = Number(process.env.MAX_UPLOAD_SIZE_MB) || 5;

const HTTPS_ENABLED = parseEnvBoolean(process.env.HTTPS_ENABLED);
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const HTTPS_REDIRECT_HTTP = parseEnvBoolean(process.env.HTTPS_REDIRECT_HTTP);
const HTTPS_CERT_PATH = normalizeText(process.env.HTTPS_CERT_PATH)
  || path.join(__dirname, 'certs', 'localhost-cert.pem');
const HTTPS_KEY_PATH = normalizeText(process.env.HTTPS_KEY_PATH)
  || path.join(__dirname, 'certs', 'localhost-key.pem');
const MONGO_MEMORY_LAUNCH_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.MONGO_MEMORY_LAUNCH_TIMEOUT_MS) || 120000
);

let inMemoryMongoServer = null;

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set. Using a development fallback secret.');
}

if (!EXPLICIT_MONGODB_URI && !IS_PROD) {
  console.warn('MONGODB_URI is not set. Trying local MongoDB first, then in-memory fallback in development.');
}

const uploadDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const logoUploadMimeTypes = new Set(['image/jpeg', 'image/png']);
const submissionUploadMimeTypes = new Set(['image/jpeg', 'image/png', 'application/pdf']);
const allowedFieldTypes = new Set([
  'text',
  'email',
  'number',
  'date',
  'textarea',
  'tel',
  'url',
  'checkbox'
]);

const formCategories = ['General', 'Marketing', 'Support', 'RH', 'Finance', 'IT', 'Operations'];
const allowedFormStatuses = new Set(['draft', 'published', 'archived']);
const passwordPolicy = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9]).{8,}$/;

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function normalizeCategory(value) {
  const candidate = normalizeText(value);
  const matched = formCategories.find(category => category.toLowerCase() === candidate.toLowerCase());
  return matched || 'General';
}

function normalizeStatus(value, fallback = 'published') {
  const candidate = normalizeText(value).toLowerCase();
  return allowedFormStatuses.has(candidate) ? candidate : fallback;
}

function validateFieldValue(field, value) {
  const type = field.type || 'text';

  if (type === 'email') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(value) ? null : 'email invalide';
  }

  if (type === 'number') {
    return Number.isFinite(Number(value)) ? null : 'nombre invalide';
  }

  if (type === 'date') {
    return Number.isNaN(Date.parse(value)) ? 'date invalide' : null;
  }

  if (type === 'url') {
    try {
      const parsed = new URL(value);
      return parsed.protocol.startsWith('http') ? null : 'url invalide';
    } catch {
      return 'url invalide';
    }
  }

  if (type === 'tel') {
    const phoneRegex = /^[0-9+().\s-]{6,25}$/;
    return phoneRegex.test(value) ? null : 'telephone invalide';
  }

  return null;
}

function parseFieldsJson(fieldsJson) {
  const text = normalizeText(fieldsJson);
  if (!text) {
    throw new HttpError(400, 'Le formulaire doit contenir au moins un champ.');
  }

  let parsedFields;
  try {
    parsedFields = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Le JSON des champs est invalide.');
  }

  if (!Array.isArray(parsedFields) || parsedFields.length === 0) {
    throw new HttpError(400, 'Le JSON des champs doit etre un tableau non vide.');
  }

  const usedNames = new Set();

  return parsedFields.map((field, index) => {
    if (!field || typeof field !== 'object') {
      throw new HttpError(400, `Le champ #${index + 1} est invalide.`);
    }

    const label = normalizeText(field.label);
    if (!label) {
      throw new HttpError(400, `Le champ #${index + 1} doit avoir un label.`);
    }

    const type = normalizeText(field.type || 'text').toLowerCase();
    if (!allowedFieldTypes.has(type)) {
      throw new HttpError(400, `Type de champ non supporte: ${type}.`);
    }

    let name = toSafeKey(field.name || label, `field-${index + 1}`);
    while (usedNames.has(name)) {
      name = `${name}-${index + 1}`;
    }
    usedNames.add(name);

    const placeholder = normalizeText(field.placeholder).slice(0, 120);
    const helpText = normalizeText(field.helpText).slice(0, 180);

    return {
      name,
      label,
      type,
      required: Boolean(field.required),
      placeholder: placeholder || undefined,
      helpText: helpText || undefined
    };
  });
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value === undefined || value === null) {
    return [];
  }

  return [value];
}

function extractFieldRows(body) {
  const names = toArray(body.fieldName);
  const labels = toArray(body.fieldLabel);
  const types = toArray(body.fieldType);
  const requiredValues = toArray(body.fieldRequired);
  const placeholders = toArray(body.fieldPlaceholder);
  const helpTexts = toArray(body.fieldHelpText);

  const rowCount = Math.max(
    names.length,
    labels.length,
    types.length,
    requiredValues.length,
    placeholders.length,
    helpTexts.length
  );

  const rows = [];

  for (let index = 0; index < rowCount; index += 1) {
    rows.push({
      name: normalizeText(names[index]),
      label: normalizeText(labels[index]),
      type: normalizeText(types[index] || 'text').toLowerCase() || 'text',
      required: parseBoolean(requiredValues[index]),
      placeholder: normalizeText(placeholders[index]).slice(0, 120),
      helpText: normalizeText(helpTexts[index]).slice(0, 180)
    });
  }

  return rows;
}

function parseFieldsFromRows(rows) {
  const usedNames = new Set();
  const parsedFields = [];

  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') {
      throw new HttpError(400, `Le champ #${index + 1} est invalide.`);
    }

    if (!row.label) {
      throw new HttpError(400, `Le champ #${index + 1} doit avoir un label.`);
    }

    if (!allowedFieldTypes.has(row.type)) {
      throw new HttpError(400, `Type de champ non supporte: ${row.type}.`);
    }

    let name = toSafeKey(row.name || row.label, `field-${index + 1}`);
    while (usedNames.has(name)) {
      name = `${name}-${index + 1}`;
    }
    usedNames.add(name);

    parsedFields.push({
      name,
      label: row.label,
      type: row.type,
      required: Boolean(row.required),
      placeholder: row.placeholder || undefined,
      helpText: row.helpText || undefined
    });
  });

  if (parsedFields.length === 0) {
    throw new HttpError(400, 'Le formulaire doit contenir au moins un champ.');
  }

  return parsedFields;
}

function parseFieldsInput(body) {
  const rowCandidates = extractFieldRows(body).filter(
    row => row.label || row.name || row.placeholder || row.helpText
  );

  if (rowCandidates.length > 0) {
    return parseFieldsFromRows(rowCandidates);
  }

  return parseFieldsJson(body.fieldsJson);
}

function extractSubmissionData(fields, body) {
  const data = {};
  const missing = [];
  const invalid = [];

  fields.forEach(field => {
    let rawValue = body[field.name];

    if (field.type === 'checkbox') {
      rawValue = parseBoolean(rawValue) ? 'true' : '';
    }

    const value = typeof rawValue === 'string' ? rawValue.trim() : rawValue;

    if (field.required && !value) {
      missing.push(field.label);
      return;
    }

    if (value === undefined || value === null || value === '') {
      return;
    }

    const validationError = validateFieldValue(field, String(value));
    if (validationError) {
      invalid.push(`${field.label} (${validationError})`);
      return;
    }

    data[field.name] = String(value);
  });

  return { data, missing, invalid };
}

function getFormCompanyId(form) {
  if (!form) {
    return null;
  }

  if (typeof form.company === 'object' && form.company?._id) {
    return form.company._id;
  }

  return form.company || null;
}

function isOwnerOfForm(form, userId) {
  const companyId = getFormCompanyId(form);
  return Boolean(companyId && userId && String(companyId) === String(userId));
}

const app = express();

if (IS_PROD) {
  app.set('trust proxy', 1);
}
app.disable('x-powered-by');

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.locals.httpsEnabled = HTTPS_ENABLED;
app.locals.httpsPort = HTTPS_PORT;

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Trop de requetes. Reessayez dans quelques minutes.'
});
app.use(globalLimiter);

if (HTTPS_ENABLED && HTTPS_REDIRECT_HTTP) {
  app.use((req, res, next) => {
    if (req.secure || req.hostname === 'localhost' && req.protocol === 'https') {
      return next();
    }

    const host = req.hostname === 'localhost' ? 'localhost' : req.hostname;
    return res.redirect(301, `https://${host}:${HTTPS_PORT}${req.originalUrl}`);
  });
}

// Upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomUUID()}${extension}`);
  }
});

function createUploader(allowedMimeTypes, acceptedLabel) {
  return multer({
    storage,
    limits: { fileSize: MAX_UPLOAD_SIZE_MB * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (allowedMimeTypes.has(file.mimetype)) {
        return cb(null, true);
      }
      cb(new HttpError(400, `Fichier non autorise. Formats acceptes: ${acceptedLabel}.`));
    }
  });
}

const logoUpload = createUploader(logoUploadMimeTypes, 'JPG, PNG');
const submissionUpload = createUploader(submissionUploadMimeTypes, 'JPG, PNG, PDF');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Trop de tentatives. Reessayez dans 15 minutes.'
});

const submissionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Trop de soumissions. Reessayez dans quelques minutes.'
});

// Session
const sessionConfig = {
  name: 'formsaas.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD
  }
};

if (NODE_ENV !== 'test') {
  if (EXPLICIT_MONGODB_URI) {
    sessionConfig.store = MongoStore.create({
      mongoUrl: EXPLICIT_MONGODB_URI,
      ttl: 14 * 24 * 60 * 60
    });
  } else if (!IS_PROD) {
    console.warn('Session store MongoDB disabled in development (MONGODB_URI missing). Using in-memory session store.');
  }
}

app.use(session(sessionConfig));

app.use((req, res, next) => {
  res.locals.title = res.locals.title || 'Form SaaS';
  res.locals.error = res.locals.error ?? null;
  res.locals.currentUser = req.session.user || null;
  res.locals.currentPath = req.path;
  res.locals.httpsEnabled = HTTPS_ENABLED;
  res.locals.httpsPort = HTTPS_PORT;
  next();
});

// Models
const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['company'], default: 'company' },
    companyName: { type: String, required: true, trim: true },
    logoPath: String
  },
  { timestamps: true }
);
const User = mongoose.model('User', userSchema);

const fieldSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    type: { type: String, enum: Array.from(allowedFieldTypes), default: 'text' },
    required: { type: Boolean, default: false },
    placeholder: String,
    helpText: String
  },
  { _id: false }
);

const formSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true },
    description: { type: String, default: '', trim: true },
    category: { type: String, default: 'General' },
    status: { type: String, enum: Array.from(allowedFormStatuses), default: 'published' },
    fields: { type: [fieldSchema], default: [] },
    template: { type: String, default: 'default' },
    allowFileUpload: { type: Boolean, default: false },
    submissionCount: { type: Number, default: 0 },
    lastSubmissionAt: Date
  },
  { timestamps: true }
);
const Form = mongoose.model('Form', formSchema);

const submissionSchema = new mongoose.Schema(
  {
    form: { type: mongoose.Schema.Types.ObjectId, ref: 'Form', required: true, index: true },
    data: { type: Object, default: {} },
    filePath: String,
    ipAddress: String,
    userAgent: String
  },
  { timestamps: true }
);
const Submission = mongoose.model('Submission', submissionSchema);

async function ensureUniqueFormSlug(sourceText, excludeId) {
  const base = toSafeKey(sourceText, 'form');

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${crypto.randomBytes(2).toString('hex')}`;
    const candidate = `${base}${suffix}`;

    const query = { slug: candidate };
    if (excludeId) {
      query._id = { $ne: excludeId };
    }

    const exists = await Form.findOne(query).select('_id').lean();
    if (!exists) {
      return candidate;
    }
  }

  return `${base}-${Date.now().toString(36)}`;
}

function requireCompany(req, res, next) {
  if (req.session.user?.role === 'company') {
    return next();
  }
  res.redirect('/login');
}

async function loadOwnedFormOrThrow(formId, userId) {
  if (!isValidObjectId(formId)) {
    throw new HttpError(404, 'Formulaire introuvable');
  }

  const form = await Form.findById(formId);
  if (!form) {
    throw new HttpError(404, 'Formulaire introuvable');
  }

  if (!isOwnerOfForm(form, userId)) {
    throw new HttpError(403, 'Acces refuse');
  }

  return form;
}

function getPublicFormPath(form) {
  if (form.slug) {
    return `/f/${form.slug}`;
  }
  return `/form/${form._id}`;
}

function canAccessForm(form, sessionUser) {
  if (!form) {
    return false;
  }

  if (form.status === 'published') {
    return true;
  }

  return isOwnerOfForm(form, sessionUser?.id);
}

async function resolveForm(identifierType, value) {
  if (identifierType === 'id') {
    if (!isValidObjectId(value)) {
      return null;
    }

    return Form.findById(value).populate('company', 'companyName').lean();
  }

  return Form.findOne({ slug: value }).populate('company', 'companyName').lean();
}

function buildSubmissionCsv(form, submissions) {
  const dynamicHeaders = (form.fields || []).map(field => field.name);
  const headers = ['submittedAt', 'ipAddress', 'userAgent', ...dynamicHeaders];

  const rows = [headers.map(csvEscape).join(',')];

  submissions.forEach(submission => {
    const baseValues = [
      new Date(submission.createdAt || Date.now()).toISOString(),
      submission.ipAddress || '',
      submission.userAgent || ''
    ];

    const dynamicValues = dynamicHeaders.map(fieldName => submission.data?.[fieldName] || '');
    const row = [...baseValues, ...dynamicValues].map(csvEscape).join(',');
    rows.push(row);
  });

  return rows.join('\n');
}

function getDefaultFields() {
  return [
    { name: 'full_name', label: 'Nom complet', type: 'text', required: true, placeholder: 'Ex: Marie Diallo' },
    { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'nom@entreprise.com' },
    { name: 'message', label: 'Message', type: 'textarea', required: false }
  ];
}

// Routes
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', httpsEnabled: HTTPS_ENABLED, environment: NODE_ENV });
});

app.get(
  '/',
  asyncHandler(async (req, res) => {
    const [companies, forms] = await Promise.all([
      User.find({}, 'companyName logoPath').sort({ companyName: 1 }).lean(),
      Form.find({ status: 'published' }, 'title company createdAt slug category submissionCount')
        .populate('company', 'companyName')
        .sort({ createdAt: -1 })
        .lean()
    ]);

    res.render('index', { title: 'Accueil', companies, forms });
  })
);

app.get('/register', (req, res) => {
  res.render('register', { title: 'Inscription', error: null });
});

app.post(
  '/register',
  authLimiter,
  logoUpload.single('logo'),
  asyncHandler(async (req, res) => {
    const username = normalizeText(req.body.username).toLowerCase();
    const password = String(req.body.password || '');
    const companyName = normalizeText(req.body.companyName);

    if (!username || !password || !companyName) {
      discardUploadedFile(req.file);
      return res.status(400).render('register', {
        title: 'Inscription',
        error: 'Tous les champs sont requis.'
      });
    }

    if (!passwordPolicy.test(password)) {
      discardUploadedFile(req.file);
      return res.status(400).render('register', {
        title: 'Inscription',
        error: 'Le mot de passe doit contenir au moins 8 caracteres, avec 1 majuscule, 1 minuscule et 1 chiffre.'
      });
    }

    if (!/^[a-z0-9._-]{3,30}$/i.test(username)) {
      discardUploadedFile(req.file);
      return res.status(400).render('register', {
        title: 'Inscription',
        error: "Nom d'utilisateur invalide (3 a 30 caracteres, lettres/chiffres/._-)."
      });
    }

    const existing = await User.findOne({ username });
    if (existing) {
      discardUploadedFile(req.file);
      return res.status(409).render('register', {
        title: 'Inscription',
        error: 'Cet utilisateur existe deja.'
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const logoPath = req.file ? `/uploads/${req.file.filename}` : undefined;

    await new User({ username, passwordHash, companyName, logoPath }).save();
    res.redirect('/login');
  })
);

app.get('/login', (req, res) => {
  res.render('login', { title: 'Connexion', error: null });
});

app.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const username = normalizeText(req.body.username).toLowerCase();
    const password = String(req.body.password || '');

    const user = await User.findOne({ username });
    const isValidPassword = user ? await bcrypt.compare(password, user.passwordHash) : false;

    if (!user || !isValidPassword) {
      return res.status(401).render('login', { title: 'Connexion', error: 'Identifiants invalides.' });
    }

    req.session.user = {
      id: user._id.toString(),
      role: user.role,
      companyName: user.companyName
    };

    res.redirect('/dashboard');
  })
);

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// Backward-compatible route for old links.
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get(
  '/dashboard',
  requireCompany,
  asyncHandler(async (req, res) => {
    const q = normalizeText(req.query.q);
    const requestedStatus = normalizeText(req.query.status).toLowerCase();
    const status = requestedStatus && requestedStatus !== 'all' && allowedFormStatuses.has(requestedStatus)
      ? requestedStatus
      : 'all';

    const baseFilter = { company: req.session.user.id };
    if (status !== 'all') {
      baseFilter.status = status;
    }

    if (q) {
      const regex = new RegExp(escapeRegex(q), 'i');
      baseFilter.$or = [
        { title: regex },
        { description: regex },
        { category: regex },
        { slug: regex }
      ];
    }

    const [forms, allForms] = await Promise.all([
      Form.find(baseFilter).sort({ updatedAt: -1 }).lean(),
      Form.find({ company: req.session.user.id }, 'status submissionCount').lean()
    ]);

    const metrics = allForms.reduce(
      (acc, form) => {
        acc.totalForms += 1;
        acc.totalSubmissions += Number(form.submissionCount || 0);

        if (form.status === 'published') {
          acc.publishedForms += 1;
        } else if (form.status === 'draft') {
          acc.draftForms += 1;
        } else if (form.status === 'archived') {
          acc.archivedForms += 1;
        }

        return acc;
      },
      {
        totalForms: 0,
        publishedForms: 0,
        draftForms: 0,
        archivedForms: 0,
        totalSubmissions: 0
      }
    );

    res.render('dashboard', {
      title: 'Tableau de bord',
      forms,
      metrics,
      filters: {
        q,
        status
      }
    });
  })
);

app.get('/form/new', requireCompany, (req, res) => {
  res.render('createForm', {
    title: 'Nouveau formulaire',
    error: null,
    categories: formCategories,
    formData: {
      title: '',
      slug: '',
      description: '',
      category: 'General',
      status: 'published',
      allowFileUpload: false,
      fields: getDefaultFields()
    }
  });
});

app.post(
  '/form/new',
  requireCompany,
  asyncHandler(async (req, res) => {
    const title = normalizeText(req.body.title);
    const requestedSlug = normalizeText(req.body.slug);
    const description = normalizeText(req.body.description).slice(0, 320);
    const category = normalizeCategory(req.body.category);
    const status = normalizeStatus(req.body.status);
    const allowFileUpload = parseBoolean(req.body.allowFileUpload);

    const formData = {
      title,
      slug: requestedSlug,
      description,
      category,
      status,
      allowFileUpload,
      fields: extractFieldRows(req.body)
    };

    if (!title) {
      return res.status(400).render('createForm', {
        title: 'Nouveau formulaire',
        error: 'Le titre est requis.',
        categories: formCategories,
        formData
      });
    }

    let fields;
    try {
      fields = parseFieldsInput(req.body);
    } catch (error) {
      return res.status(400).render('createForm', {
        title: 'Nouveau formulaire',
        error: error.message || 'Configuration invalide des champs.',
        categories: formCategories,
        formData
      });
    }

    const slug = await ensureUniqueFormSlug(requestedSlug || title);

    await new Form({
      company: req.session.user.id,
      title,
      slug,
      description,
      category,
      status,
      fields,
      template: normalizeText(req.body.template) || 'default',
      allowFileUpload
    }).save();

    res.redirect('/dashboard?created=1');
  })
);

app.get(
  '/form/edit/:id',
  requireCompany,
  asyncHandler(async (req, res) => {
    const form = await loadOwnedFormOrThrow(req.params.id, req.session.user.id);

    res.render('editForm', {
      title: 'Modifier le formulaire',
      form,
      categories: formCategories,
      formData: {
        title: form.title,
        slug: form.slug,
        description: form.description || '',
        category: form.category || 'General',
        status: form.status || 'published',
        allowFileUpload: Boolean(form.allowFileUpload),
        fields: form.fields || []
      },
      error: null
    });
  })
);

app.post(
  '/form/edit/:id',
  requireCompany,
  asyncHandler(async (req, res) => {
    const form = await loadOwnedFormOrThrow(req.params.id, req.session.user.id);

    const title = normalizeText(req.body.title);
    const requestedSlug = normalizeText(req.body.slug);
    const description = normalizeText(req.body.description).slice(0, 320);
    const category = normalizeCategory(req.body.category);
    const status = normalizeStatus(req.body.status);
    const allowFileUpload = parseBoolean(req.body.allowFileUpload);

    const formData = {
      title,
      slug: requestedSlug,
      description,
      category,
      status,
      allowFileUpload,
      fields: extractFieldRows(req.body)
    };

    if (!title) {
      return res.status(400).render('editForm', {
        title: 'Modifier le formulaire',
        form,
        categories: formCategories,
        formData,
        error: 'Le titre est requis.'
      });
    }

    let fields;
    try {
      fields = parseFieldsInput(req.body);
    } catch (error) {
      return res.status(400).render('editForm', {
        title: 'Modifier le formulaire',
        form,
        categories: formCategories,
        formData,
        error: error.message || 'Configuration invalide des champs.'
      });
    }

    const slug = await ensureUniqueFormSlug(requestedSlug || form.slug || title, form._id);

    form.title = title;
    form.slug = slug;
    form.description = description;
    form.category = category;
    form.status = status;
    form.fields = fields;
    form.allowFileUpload = allowFileUpload;
    await form.save();

    res.redirect('/dashboard?updated=1');
  })
);

app.post(
  '/form/duplicate/:id',
  requireCompany,
  asyncHandler(async (req, res) => {
    const source = await loadOwnedFormOrThrow(req.params.id, req.session.user.id);
    const duplicatedTitle = `${source.title} - copie`;
    const slug = await ensureUniqueFormSlug(`${source.slug}-copy`);

    await new Form({
      company: source.company,
      title: duplicatedTitle,
      slug,
      description: source.description,
      category: source.category,
      status: 'draft',
      fields: source.fields,
      template: source.template,
      allowFileUpload: source.allowFileUpload,
      submissionCount: 0,
      lastSubmissionAt: null
    }).save();

    res.redirect('/dashboard?duplicated=1');
  })
);

app.post(
  '/form/status/:id',
  requireCompany,
  asyncHandler(async (req, res) => {
    const form = await loadOwnedFormOrThrow(req.params.id, req.session.user.id);
    form.status = normalizeStatus(req.body.status, form.status);
    await form.save();
    res.redirect('/dashboard');
  })
);

app.post(
  '/form/delete/:id',
  requireCompany,
  asyncHandler(async (req, res) => {
    const form = await loadOwnedFormOrThrow(req.params.id, req.session.user.id);

    const submissions = await Submission.find({ form: form._id }, 'filePath').lean();
    submissions.forEach(submission => discardStoredFilePath(submission.filePath));

    await Submission.deleteMany({ form: form._id });
    await Form.deleteOne({ _id: form._id });

    res.redirect('/dashboard?deleted=1');
  })
);

app.get(
  '/form/submissions/:id',
  requireCompany,
  asyncHandler(async (req, res) => {
    const form = await loadOwnedFormOrThrow(req.params.id, req.session.user.id);

    const submissions = await Submission.find({ form: form._id }).sort({ createdAt: -1 }).lean();

    res.render('submissions', {
      title: 'Soumissions',
      form,
      submissions,
      totalSubmissions: submissions.length
    });
  })
);

app.get(
  '/form/submissions/:id/export.csv',
  requireCompany,
  asyncHandler(async (req, res) => {
    const form = await loadOwnedFormOrThrow(req.params.id, req.session.user.id);

    const submissions = await Submission.find({ form: form._id }).sort({ createdAt: -1 }).lean();
    const csv = buildSubmissionCsv(form, submissions);

    const filename = `${sanitizeFileName(form.slug || form.title, 'submissions')}-submissions.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csv);
  })
);

app.get(
  '/settings',
  requireCompany,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.session.user.id).lean();
    if (!user) {
      req.session.destroy(() => res.redirect('/login'));
      return;
    }

    res.render('settings', {
      title: 'Parametres',
      user,
      saved: req.query.saved === '1',
      error: null
    });
  })
);

app.post(
  '/settings',
  requireCompany,
  logoUpload.single('logo'),
  asyncHandler(async (req, res) => {
    const companyName = normalizeText(req.body.companyName);
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    const confirmPassword = String(req.body.confirmPassword || '');

    const user = await User.findById(req.session.user.id);
    if (!user) {
      discardUploadedFile(req.file);
      req.session.destroy(() => res.redirect('/login'));
      return;
    }

    if (!companyName) {
      discardUploadedFile(req.file);
      return res.status(400).render('settings', {
        title: 'Parametres',
        user,
        saved: false,
        error: 'Le nom de votre entreprise est requis.'
      });
    }

    const wantsPasswordChange = currentPassword || newPassword || confirmPassword;
    if (wantsPasswordChange) {
      const validCurrentPassword = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!validCurrentPassword) {
        discardUploadedFile(req.file);
        return res.status(400).render('settings', {
          title: 'Parametres',
          user,
          saved: false,
          error: 'Mot de passe actuel invalide.'
        });
      }

      if (newPassword !== confirmPassword) {
        discardUploadedFile(req.file);
        return res.status(400).render('settings', {
          title: 'Parametres',
          user,
          saved: false,
          error: 'Le nouveau mot de passe et la confirmation ne correspondent pas.'
        });
      }

      if (!passwordPolicy.test(newPassword)) {
        discardUploadedFile(req.file);
        return res.status(400).render('settings', {
          title: 'Parametres',
          user,
          saved: false,
          error: 'Le nouveau mot de passe doit contenir au moins 8 caracteres, avec 1 majuscule, 1 minuscule et 1 chiffre.'
        });
      }

      user.passwordHash = await bcrypt.hash(newPassword, 12);
    }

    if (req.file) {
      discardStoredFilePath(user.logoPath);
      user.logoPath = `/uploads/${req.file.filename}`;
    }

    user.companyName = companyName;
    await user.save();

    req.session.user.companyName = user.companyName;

    res.redirect('/settings?saved=1');
  })
);

async function renderPublicForm(req, res, identifierType) {
  const identifier = identifierType === 'id' ? req.params.id : req.params.slug;
  const form = await resolveForm(identifierType, identifier);

  if (!form) {
    return res.status(404).send('Formulaire introuvable');
  }

  if (!canAccessForm(form, req.session.user)) {
    return res.status(404).send('Formulaire introuvable');
  }

  if (form.status === 'archived') {
    return res.status(410).send('Ce formulaire est archive.');
  }

  return res.render('form', {
    title: form.title,
    form,
    isPreview: form.status !== 'published',
    publicAction: getPublicFormPath(form),
    error: null
  });
}

async function handlePublicSubmission(req, res, identifierType) {
  const identifier = identifierType === 'id' ? req.params.id : req.params.slug;
  const form = await resolveForm(identifierType, identifier);

  if (!form) {
    discardUploadedFile(req.file);
    return res.status(404).send('Formulaire introuvable');
  }

  if (!canAccessForm(form, req.session.user)) {
    discardUploadedFile(req.file);
    return res.status(404).send('Formulaire introuvable');
  }

  if (form.status === 'archived') {
    discardUploadedFile(req.file);
    return res.status(410).send('Ce formulaire est archive.');
  }

  if (!form.allowFileUpload && req.file) {
    discardUploadedFile(req.file);
    return res.status(400).render('form', {
      title: form.title,
      form,
      isPreview: form.status !== 'published',
      publicAction: getPublicFormPath(form),
      error: "Ce formulaire n'accepte pas de fichier."
    });
  }

  const { data, missing, invalid } = extractSubmissionData(form.fields || [], req.body);

  if (missing.length > 0) {
    discardUploadedFile(req.file);
    return res.status(400).render('form', {
      title: form.title,
      form,
      isPreview: form.status !== 'published',
      publicAction: getPublicFormPath(form),
      error: `Champs obligatoires manquants: ${missing.join(', ')}.`
    });
  }

  if (invalid.length > 0) {
    discardUploadedFile(req.file);
    return res.status(400).render('form', {
      title: form.title,
      form,
      isPreview: form.status !== 'published',
      publicAction: getPublicFormPath(form),
      error: `Donnees invalides: ${invalid.join(', ')}.`
    });
  }

  const filePath = req.file ? `/uploads/${req.file.filename}` : undefined;

  await new Submission({
    form: form._id,
    data,
    filePath,
    ipAddress: getClientIp(req),
    userAgent: normalizeText(req.headers['user-agent'])
  }).save();

  await Form.updateOne(
    { _id: form._id },
    {
      $inc: { submissionCount: 1 },
      $set: { lastSubmissionAt: new Date() }
    }
  );

  return res.render('thanks', {
    title: 'Merci',
    formTitle: form.title,
    companyName: form.company?.companyName || ''
  });
}

app.get('/f/:slug', asyncHandler(async (req, res) => renderPublicForm(req, res, 'slug')));
app.post('/f/:slug', submissionLimiter, submissionUpload.single('file'), asyncHandler(async (req, res) => handlePublicSubmission(req, res, 'slug')));

// Backward-compatible public routes by id.
app.get('/form/:id', asyncHandler(async (req, res) => renderPublicForm(req, res, 'id')));
app.post('/form/:id', submissionLimiter, submissionUpload.single('file'), asyncHandler(async (req, res) => handlePublicSubmission(req, res, 'id')));

app.use((req, res) => {
  res.status(404).send('Page non trouvee');
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).send(`Fichier trop volumineux. Limite: ${MAX_UPLOAD_SIZE_MB}MB.`);
  }

  const statusCode = err.statusCode || 500;
  const message = statusCode >= 500 ? 'Une erreur interne est survenue.' : err.message;

  if (statusCode >= 500) {
    console.error(err);
  }

  res.status(statusCode).send(message);
});

async function connectToDatabase() {
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    console.log(`Connected to MongoDB at ${MONGODB_URI}`);
    return;
  } catch (initialError) {
    const canUseFallback = !IS_PROD && !EXPLICIT_MONGODB_URI;

    if (!canUseFallback) {
      throw initialError;
    }

    console.warn(
      `Unable to connect to local MongoDB (${MONGODB_URI}). Falling back to in-memory MongoDB for development.`
    );

    try {
      const { MongoMemoryServer } = require('mongodb-memory-server');
      inMemoryMongoServer = await MongoMemoryServer.create({
        instance: {
          dbName: 'formsaas',
          launchTimeout: MONGO_MEMORY_LAUNCH_TIMEOUT_MS
        }
      });

      const inMemoryUri = inMemoryMongoServer.getUri();
      await mongoose.connect(inMemoryUri, { serverSelectionTimeoutMS: 5000 });
      console.log('Connected to in-memory MongoDB (development fallback).');
      console.warn('Data persistence is disabled in this mode and will be lost when the process stops.');
    } catch (fallbackError) {
      const combinedMessage =
        'Database startup failed: local MongoDB is unreachable and in-memory fallback could not start. '
        + 'Install MongoDB locally or set MONGODB_URI to a reachable database. '
        + `Details: ${fallbackError.message}`;
      const error = new Error(combinedMessage);
      error.cause = fallbackError;
      throw error;
    }
  }
}

function ensureHttpsCertificate() {
  if (fs.existsSync(HTTPS_KEY_PATH) && fs.existsSync(HTTPS_CERT_PATH)) {
    return {
      key: fs.readFileSync(HTTPS_KEY_PATH, 'utf8'),
      cert: fs.readFileSync(HTTPS_CERT_PATH, 'utf8')
    };
  }

  if (IS_PROD) {
    throw new Error(
      'HTTPS is enabled but certificate files are missing in production. '
      + `Expected key: ${HTTPS_KEY_PATH}, cert: ${HTTPS_CERT_PATH}`
    );
  }

  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const pems = selfsigned.generate(attrs, {
    algorithm: 'sha256',
    days: 365,
    keySize: 2048,
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' }
        ]
      }
    ]
  });

  fs.mkdirSync(path.dirname(HTTPS_KEY_PATH), { recursive: true });
  fs.writeFileSync(HTTPS_KEY_PATH, pems.private, 'utf8');
  fs.writeFileSync(HTTPS_CERT_PATH, pems.cert, 'utf8');

  console.warn(`Generated self-signed certificate: ${HTTPS_CERT_PATH}`);

  return {
    key: fs.readFileSync(HTTPS_KEY_PATH, 'utf8'),
    cert: fs.readFileSync(HTTPS_CERT_PATH, 'utf8')
  };
}

function listenServer(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      console.log(`${label} server listening on port ${port}`);
      resolve();
    });
  });
}

async function startServer() {
  await connectToDatabase();

  const httpServer = http.createServer(app);
  await listenServer(httpServer, PORT, 'HTTP');

  if (HTTPS_ENABLED) {
    const tlsOptions = ensureHttpsCertificate();
    const httpsServer = https.createServer(tlsOptions, app);
    await listenServer(httpsServer, HTTPS_PORT, 'HTTPS');

    console.log(`Secure URL: https://localhost:${HTTPS_PORT}`);

    if (HTTPS_REDIRECT_HTTP) {
      console.log('HTTP to HTTPS redirection is enabled.');
    }
  }
}

if (require.main === module) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = { app, startServer };
