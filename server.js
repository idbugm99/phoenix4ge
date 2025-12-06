const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { engine } = require('express-handlebars');
const axios = require('axios');
const { registerComponent } = require('./utils/componentRegistry');
require('dotenv').config();

const { testConnection } = require('./config/database');
const db = require('./config/database');
const { validateConfig } = require('./utils/validateConfig');
const ApiKeyAuth = require('./src/middleware/apiKeyAuth');
const AnalysisConfigAPI = require('./src/routes/analysisConfigApi');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Cloudflare (specific IP ranges)
// Cloudflare IP ranges - more secure than 'true'
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal', 
    // Cloudflare IPv4 ranges (partial list)
    '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22',
    '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
    '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22',
    '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
    '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
]);

// Early ping route to bypass middleware stack for diagnostics
app.get('/_ping', (_req, res) => res.status(200).send('pong'));

// Validate configuration early
try {
    validateConfig(process.env);
} catch (e) {
    console.error('Fatal configuration error:', e.message);
    process.exit(1);
}

// Security middleware (disabled HTTPS redirect in development)
if (process.env.NODE_ENV === 'production') {
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com"],
                scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://code.jquery.com"],
                imgSrc: ["'self'", "data:", "https:"],
                fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
                connectSrc: ["'self'"],
                // Allow inline script attributes for legacy templates that use inline handlers
                scriptSrcAttr: ["'self'", "'unsafe-inline'"]
            },
        },
    }));
} else {
    // Development mode - minimal security headers, no HTTPS enforcement
    app.use(helmet({
        contentSecurityPolicy: false,
        hsts: false,
    }));
}

// Rate limiting (reasonable limits with static asset exclusion)
const limiter = rateLimit({
    windowMs: (process.env.RATE_LIMIT_WINDOW || 15) * 60 * 1000, // 15 minutes
    max: process.env.NODE_ENV === 'development' ? 1000 : (process.env.RATE_LIMIT_MAX || 100),
    message: 'Too many requests from this IP, please try again later.',
    skip: (req) => {
        // Skip rate limiting for static assets and localhost in development
        return req.url.startsWith('/public/') || 
               req.url.startsWith('/uploads/') ||
               req.url.endsWith('.css') ||
               req.url.endsWith('.js') ||
               req.url.endsWith('.png') ||
               req.url.endsWith('.jpg') ||
               req.url.endsWith('.ico') ||
               (process.env.NODE_ENV === 'development' && req.ip === '::1');
    }
});
app.use(limiter);

// CORS
app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : true,
    credentials: true
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Session middleware (required for CRM)
app.use(session({
    name: 'crm.sid',
    secret: process.env.SESSION_SECRET || process.env.JWT_SECRET || 'replace_this_secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// Request logging (after body parsing to capture JSON when enabled)
app.use(require('./middleware/requestLogger'));

// Standard response envelope
app.use(require('./middleware/responseEnvelope'));

// Impersonation middleware (must be after session handling)
const { impersonationMiddleware } = require('./middleware/impersonation');
app.use(impersonationMiddleware);

// Session-based authentication middleware
const { requireAuth, requireModelAccess, requireAdmin } = require('./middleware/sessionAuth');

// Static files
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
// CRM theme static assets
app.use('/crm/css', express.static(path.join(__dirname, 'public/crm/css')));
app.use('/crm/js', express.static(path.join(__dirname, 'public/crm/js')));

// Serve model-specific system uploads (logos, watermarks, etc.)
app.use('/:slug/uploads/system', (req, res, next) => {
    const { slug } = req.params;
    const systemPath = path.join(__dirname, 'public/uploads', slug, 'system');
    
    // Check if the system directory exists
    if (!fs.existsSync(systemPath)) {
        return res.status(404).send('System uploads not found');
    }
    
    // Serve static files from the model's system directory
    express.static(systemPath)(req, res, next);
});

// Serve model-specific uploads (thumbs, public, etc.)
app.use('/:slug/uploads', (req, res, next) => {
    const { slug } = req.params;
    const modelUploadsPath = path.join(__dirname, 'public/uploads', slug);
    
    // Check if the model uploads directory exists
    if (!fs.existsSync(modelUploadsPath)) {
        return res.status(404).send('Model uploads not found');
    }
    
    // Serve static files from the model's uploads directory
    express.static(modelUploadsPath)(req, res, next);
});
// Admin static files (for components and assets)
app.use('/admin/components', express.static(path.join(__dirname, 'admin/components')));
app.use('/admin/assets', express.static(path.join(__dirname, 'admin/assets')));
app.use('/admin/js', express.static(path.join(__dirname, 'admin/js')));
app.use('/admin/pages', express.static(path.join(__dirname, 'admin/pages')));

// Templates static files (for universal gallery system)
app.use('/templates', express.static(path.join(__dirname, 'templates')));

// Themes static files (for theme-specific assets like CSS and JS)
app.use('/themes', express.static(path.join(__dirname, 'themes')));

// Normalize API paths: collapse multiple slashes and strip trailing slashes (except root)
app.use('/api', (req, _res, next) => {
    const original = req.url;
    let normalized = original.replace(/\/+/g, '/');
    if (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }
    if (normalized !== original) {
        req.url = normalized;
    }
    next();
});

// Serve the media queue review page
app.get('/admin/media-queue-review.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'media-queue-review.html'));
});

// Serve the file upload test page
app.get('/test-file-upload', (req, res) => {
    res.sendFile(path.join(__dirname, 'test-file-upload.html'));
});

// Redirect old admin paths to system admin
app.get('/admin/phoenix4ge-business-manager.html', (req, res) => res.redirect('/sysadmin'));

// Test route for system admin Handlebars 
app.get('/sysadmin/test', (req, res) => {
    res.render('admin/pages/dashboard', {
        layout: 'admin/layouts/main',
        pageTitle: 'Test SysAdmin Dashboard',
        stats: { totalClients: 4, activeClients: 2, assignedThemes: 3, contentPages: 11 },
        recentActivity: [],
        clientCount: 4
    });
});

// Remove backup route; use sysadmin instead
app.use('/js', express.static(path.join(__dirname, 'public/js')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// Configure Handlebars templating engine
app.engine('handlebars', engine({
    layoutsDir: path.join(__dirname, 'themes'),
    partialsDir: [
        path.join(__dirname, 'themes/basic/partials'),
        path.join(__dirname, 'themes/glamour/partials'),
        path.join(__dirname, 'themes/luxury/partials'),
        path.join(__dirname, 'themes/modern/partials'),
        path.join(__dirname, 'themes/dark/partials'),
        path.join(__dirname, 'themes/admin/partials'), // Admin partials
        path.join(__dirname, 'themes/crm/partials'), // CRM partials
        path.join(__dirname, 'themes/partials') // Global partials
    ],
    defaultLayout: false, // We'll specify layouts per theme
    extname: '.handlebars',
    helpers: {
        // Helper functions for themes
        eq: (a, b) => a === b,
        ne: (a, b) => a !== b,
        lt: (a, b) => a < b,
        gt: (a, b) => a > b,
        and: (a, b) => a && b,
        or: (a, b) => a || b,
        json: (context) => JSON.stringify(context),
        formatDate: (date, format) => {
            if (!date) return '';
            const d = new Date(date);
            if (format === 'DD') return d.getDate().toString().padStart(2, '0');
            if (format === 'MMM') return d.toLocaleDateString('en-US', { month: 'short' });
            if (format === 'MMM DD, YYYY') return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            return d.toLocaleDateString();
        },
        formatCurrency: (amount) => {
            if (!amount || isNaN(amount)) return '$0.00';
            return `$${parseFloat(amount).toFixed(2)}`;
        },
        truncate: (str, length = 100) => str && str.length > length ? str.substring(0, length) + '...' : str,
        add: (a, b) => a + b,
        subtract: (a, b) => a - b,
        gt: (a, b) => a > b,
        range: (start, end) => {
            const result = [];
            for (let i = start; i <= end; i++) {
                result.push(i);
            }
            return result;
        },
        
        // Component rendering helper (Phase A: Admin Interface Fix)
        renderComponent: function(componentName) {
            const componentLoader = require('./utils/componentLoader');
            return componentLoader.loadComponentSync(componentName);
        },
        
        // Gallery helpers (Phase 5: Gallery Layouts)
        // Note: These are loaded into template context by the model middleware
        renderGalleries: function(modelSlug) {
            // Return pre-loaded gallery data from template context
            return this.galleries ? this.galleries.renderHtml : '<div class="galleries-empty">No galleries available</div>';
        },
        renderGallerySection: function(modelSlug, sectionSlug) {
            // Return specific section from pre-loaded data
            const section = this.galleries && this.galleries.sections ? 
                this.galleries.sections.find(s => s.slug === sectionSlug) : null;
            return section ? section.renderHtml : `<div class="gallery-not-found">Gallery section "${sectionSlug}" not found</div>`;
        },
        renderGalleryByType: function(modelSlug, layoutType) {
            // Return first section of specified type from pre-loaded data
            const section = this.galleries && this.galleries.sections ? 
                this.galleries.sections.find(s => s.layout_type === layoutType) : null;
            return section ? section.renderHtml : `<div class="gallery-not-found">No ${layoutType} gallery found</div>`;
        },
        hasGalleries: function(modelSlug) {
            // Check pre-loaded gallery data
            return this.galleries && this.galleries.sections && this.galleries.sections.length > 0;
        },
        getFeaturedGalleryImages: function(modelSlug, limit = 6) {
            // Return pre-loaded featured images
            return this.galleries && this.galleries.featuredImages ? 
                this.galleries.featuredImages.slice(0, limit) : [];
        },
        
        // String manipulation helpers for contact templates
        toLowerCase: (str) => {
            if (!str) return '';
            return String(str).toLowerCase();
        },
        trim: (str) => {
            if (!str) return '';
            return String(str).trim();
        },
        split: (str, delimiter) => {
            if (!str) return [];
            return str.split(delimiter);
        },
        
    }
}));
app.set('view engine', 'handlebars');
app.set('views', [
    path.join(__dirname, 'themes'),
    path.join(__dirname, 'themes/crm'),
    path.join(__dirname, 'themes/admin')
]);

// Register major admin surfaces for duplicate detection in development
registerComponent('route:/sysadmin', 'server.js');
registerComponent('route:/admin', 'server.js');

// Ensure sysadmin pages are rendered with null-safe defaults and a dev banner
function renderSysadmin(res, viewPath, context = {}) {
    const defaultStats = {
        totalClients: 0,
        activeClients: 0,
        assignedThemes: 0,
        contentPages: 0
    };
    const defaults = {
        layout: 'admin/layouts/main',
        pageTitle: 'System Administration',
        pageSubtitle: 'phoenix4ge Business Manager',
        currentPage: 'dashboard',
        stats: defaultStats,
        recentActivity: [],
        clientCount: 0,
        devBanner: {
            env: process.env.NODE_ENV || 'development',
            db: 'OK'
        }
    };
    const merged = {
        ...defaults,
        ...context,
        stats: { ...defaultStats, ...(context.stats || {}) }
    };
    return res.render(viewPath, merged);
}

// Dev banner middleware for all /sysadmin pages (even if a route forgets to set it)
app.use('/sysadmin', (req, res, next) => {
    if (!res.locals.devBanner && process.env.NODE_ENV !== 'production') {
        res.locals.devBanner = { env: process.env.NODE_ENV || 'development', db: 'OK' };
    }
    next();
});

// Safe DB helpers for sysadmin rendering
async function safeCount(query, params = []) {
    try {
        const [rows] = await db.execute(query, params);
        const key = Object.keys(rows?.[0] || { c: 0 })[0];
        return rows?.[0]?.[key] ?? 0;
    } catch (e) {
        console.warn('safeCount warning:', e.message);
        return 0;
    }
}

// System Admin Dashboard Route (Handlebars) - Comprehensive Business Manager
app.get('/sysadmin', requireAuth, requireAdmin, async (req, res) => {
    // Collect stats, but never fail the page render
    const totalClients = await safeCount('SELECT COUNT(*) AS c FROM models');
    const activeClients = await safeCount('SELECT COUNT(*) AS c FROM models WHERE status = "active"');
    const assignedThemes = await safeCount('SELECT COUNT(*) AS c FROM models WHERE theme_set_id IS NOT NULL');
    const contentPages = await safeCount('SELECT COUNT(DISTINCT CONCAT(model_id, "-", page_type_id)) AS c FROM content_templates');

    const stats = { totalClients, activeClients, assignedThemes, contentPages };

    // Recent activity (mock data for now)
    const recentActivity = [
        { title: 'Theme Assignment', description: 'Glamour theme assigned to Model Example', timestamp: 'Just now', type: 'success', icon: 'palette' },
        { title: 'Content Update', description: 'Contact page content updated', timestamp: '5 minutes ago', type: 'info', icon: 'edit' }
    ];

    const requestedSection = req.query.section;
    renderSysadmin(res, 'admin/pages/dashboard', {
        pageSubtitle: 'phoenix4ge Business Manager - Comprehensive CRM',
        stats,
        recentActivity,
        clientCount: stats.totalClients,
        initialSection: requestedSection
    });
});

// Login page route
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/login.html'));
});

// Logout route
app.post('/logout', requireAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const sessionId = req.body.sessionId;

        // End analytics session if provided
        if (sessionId) {
            const analyticsService = require('./src/services/AnalyticsService');
            await analyticsService.endSession(sessionId, 'logout');
        }

        // Revoke refresh tokens (optional - uncomment if you want to invalidate all sessions)
        // const refreshTokenService = require('./src/services/RefreshTokenService');
        // await refreshTokenService.revokeUserTokens(userId);

        // Clear cookie
        res.clearCookie('accessToken');

        res.json({
            message: 'Logged out successfully'
        });

    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({
            message: 'Logout completed with errors'
        });
    }
});

// Model Admin Dashboard Route - Individual model management
app.get('/admin', requireAuth, async (req, res) => res.redirect('/modelexample/admin'));

// Canonical model admin dashboard
app.get('/:slug/admin', requireAuth, requireModelAccess, async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT m.id, m.name, m.slug, m.email, m.status, m.theme_set_id,
                    ts.name as theme_name, ts.display_name as theme_display_name
             FROM models m
             LEFT JOIN theme_sets ts ON m.theme_set_id = ts.id
             WHERE m.slug = ?
             LIMIT 1`,
            [slug]
        );
        if (!rows.length) return res.status(404).send('Model not found');
        const model = rows[0];
        const contentRows = await db.query('SELECT COUNT(DISTINCT page_type_id) as pages FROM content_templates WHERE model_id = ?', [model.id]);
        const stats = { pageViews: '1,234', contentPages: contentRows[0]?.pages || 0, lastUpdated: 'Today' };
        res.render('admin/pages/model-admin', {
            layout: 'admin/layouts/main', pageTitle: `${model.name} Dashboard`, pageSubtitle: 'Manage your content and view your site',
            currentPage: 'model-admin', isModelAdmin: true, model, stats,
            devBanner: { env: process.env.NODE_ENV || 'development', db: 'OK' },
            legacyBanner: { message: 'This is a legacy admin surface. System admin lives at /sysadmin.' }
        });
    } catch (error) {
        console.error('❌ Error loading model admin:', error);
        res.status(500).send('Error loading model admin dashboard');
    }
});

// Gallery routes moved to after API routes to avoid conflicts

// Model Admin: Content page
app.get('/:slug/admin/content', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        
        // Load content hub component
        const contentHubPath = path.join(__dirname, 'admin/components/content-hub.html');
        const fs = require('fs');
        const contentHubHTML = fs.readFileSync(contentHubPath, 'utf8');
        
        res.render('admin/layouts/main', {
            pageTitle: 'Content Management Hub',
            currentPage: 'content-hub',
            isModelAdmin: true,
            model: rows[0],
            body: contentHubHTML
        });
    } catch (e) {
        console.error('❌ Error loading content hub:', e);
        res.status(500).send('Error loading content hub');
    }
});

// New Model Admin: Content Hub
app.get('/:slug/admin/content/hub', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        
        // Load content hub component
        const contentHubPath = path.join(__dirname, 'admin/components/content-hub.html');
        const fs = require('fs');
        const contentHubHTML = fs.readFileSync(contentHubPath, 'utf8');
        
        res.render('admin/layouts/main', {
            pageTitle: 'Content Management Hub',
            currentPage: 'content-hub',
            isModelAdmin: true,
            model: rows[0],
            body: contentHubHTML
        });
    } catch (e) {
        console.error('❌ Error loading content hub:', e);
        res.status(500).send('Error loading content hub');
    }
});

// New Model Admin: Home Page Editor
app.get('/:slug/admin/content/home', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        
        // Load home page editor component
        const homeEditorPath = path.join(__dirname, 'admin/components/home-page-editor.html');
        const fs = require('fs');
        const homeEditorHTML = fs.readFileSync(homeEditorPath, 'utf8');
        
        res.render('admin/layouts/main', {
            pageTitle: 'Home Page Content Editor',
            currentPage: 'home-page-editor',
            isModelAdmin: true,
            model: rows[0],
            body: homeEditorHTML
        });
    } catch (e) {
        console.error('❌ Error loading home page editor:', e);
        res.status(500).send('Error loading home page editor');
    }
});

// New Model Admin: About Page Editor
app.get('/:slug/admin/content/about', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        
        const aboutEditorPath = path.join(__dirname, 'admin/components/about-page-editor.html');
        const fs = require('fs');
        const aboutEditorHTML = fs.readFileSync(aboutEditorPath, 'utf8');
        
        res.render('admin/layouts/main', {
            pageTitle: 'About Page Content Editor',
            currentPage: 'about-page-editor',
            isModelAdmin: true,
            model: rows[0],
            body: aboutEditorHTML
        });
    } catch (e) {
        console.error('❌ Error loading about page editor:', e);
        res.status(500).send('Error loading about page editor');
    }
});

// Rates API (table-driven)
app.use('/api/model-rates', require('./routes/api/model-rates'));
app.use('/api/model-etiquette', require('./routes/api/model-etiquette'));
app.use('/api/model-about', require('./routes/api/model-about'));
app.use('/api/model-home', require('./routes/api/model-home'));
app.use('/api/model-contact', require('./routes/api/model-contact'));

// Universal Gallery Admin API
app.use('/api/universal-gallery', require('./routes/api/universal-gallery'));
app.use('/api/universal-gallery-profiles', require('./routes/api/gallery-profiles'));

// Theme Management APIs
app.use('/api/admin/themes', require('./routes/api/admin/themes'));
app.use('/api/theme-custom', require('./routes/api/theme-custom'));

// New Model Admin: Gallery Page Editor
app.get('/:slug/admin/content/gallery', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        
        const galleryEditorPath = path.join(__dirname, 'admin/components/gallery-page-editor.html');
        const fs = require('fs');
        const galleryEditorHTML = fs.readFileSync(galleryEditorPath, 'utf8');
        
        res.render('admin/layouts/main', {
            pageTitle: 'Gallery Page Content Editor',
            currentPage: 'gallery-page-editor',
            isModelAdmin: true,
            model: rows[0],
            body: galleryEditorHTML
        });
    } catch (e) {
        console.error('❌ Error loading gallery page editor:', e);
        res.status(500).send('Error loading gallery page editor');
    }
});

// New Model Admin: Rates Page Editor
app.get('/:slug/admin/content/rates', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        
        const ratesEditorPath = path.join(__dirname, 'admin/components/rates-page-editor.html');
        const fs = require('fs');
        const ratesEditorHTML = fs.readFileSync(ratesEditorPath, 'utf8');
        
        res.render('admin/layouts/main', {
            pageTitle: 'Rates Page Content Editor',
            currentPage: 'rates-page-editor',
            isModelAdmin: true,
            model: rows[0],
            body: ratesEditorHTML
        });
    } catch (e) {
        console.error('❌ Error loading rates page editor:', e);
        res.status(500).send('Error loading rates page editor');
    }
});

// New Model Admin: Etiquette Page Editor
app.get('/:slug/admin/content/etiquette', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        
        const etiquetteEditorPath = path.join(__dirname, 'admin/components/etiquette-editor.html');
        const fs = require('fs');
        const etiquetteEditorHTML = fs.readFileSync(etiquetteEditorPath, 'utf8');
        
        res.render('admin/layouts/main', {
            pageTitle: 'Etiquette Page Content Editor',
            currentPage: 'etiquette-page-editor',
            isModelAdmin: true,
            model: rows[0],
            body: etiquetteEditorHTML
        });
    } catch (e) {
        console.error('❌ Error loading etiquette page editor:', e);
        res.status(500).send('Error loading etiquette page editor');
    }
});

// New Model Admin: Contact Page Editor
app.get('/:slug/admin/content/contact', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        
        const contactEditorPath = path.join(__dirname, 'admin/components/contact-page-editor.html');
        const fs = require('fs');
        const contactEditorHTML = fs.readFileSync(contactEditorPath, 'utf8');
        
        res.render('admin/layouts/main', {
            pageTitle: 'Contact Page Content Editor',
            currentPage: 'contact-page-editor',
            isModelAdmin: true,
            model: rows[0],
            body: contactEditorHTML
        });
    } catch (e) {
        console.error('❌ Error loading contact page editor:', e);
        res.status(500).send('Error loading contact page editor');
    }
});

// Model Admin: About Page Content Editor
app.get('/:slug/admin/content/about', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        
        const aboutEditorPath = path.join(__dirname, 'admin/components/about-page-editor.html');
        const fs = require('fs');
        const aboutEditorHTML = fs.readFileSync(aboutEditorPath, 'utf8');
        
        res.render('admin/layouts/main', {
            pageTitle: 'About Page Content Editor',
            currentPage: 'about-page-editor',
            isModelAdmin: true,
            model: rows[0],
            body: aboutEditorHTML
        });
    } catch (e) {
        console.error('❌ Error loading about page editor:', e);
        res.status(500).send('Error loading about page editor');
    }
});

// Model Admin: Media Library
app.get('/:slug/admin/media-library', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        
        res.render('admin/pages/media-library', {
            layout: 'admin/layouts/main',
            pageTitle: 'Media Library',
            currentPage: 'media-library',
            isModelAdmin: true,
            model: rows[0],
            modelSlug: slug
        });
    } catch (e) {
        console.error('❌ Error loading media library:', e);
        res.status(500).send('Error loading media library');
    }
});

// Model Admin: Gallery Sections
app.get('/:slug/admin/gallery-sections', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        
        res.render('admin/pages/gallery-sections', {
            layout: 'admin/layouts/main',
            pageTitle: 'Gallery Sections',
            currentPage: 'gallery-sections', 
            isModelAdmin: true,
            model: rows[0],
            modelSlug: slug
        });
    } catch (e) {
        console.error('❌ Error loading gallery sections:', e);
        res.status(500).send('Error loading gallery sections');
    }
});

// Model Admin: Settings page
app.get('/:slug/admin/settings', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        res.render('admin/pages/model-settings', {
            layout: 'admin/layouts/main',
            pageTitle: 'Site Settings',
            currentPage: 'model-settings',
            isModelAdmin: true,
            model: rows[0]
        });
    } catch (err) {
        res.status(500).send('Failed to render settings');
    }
});

// Model Admin: Testimonials page
app.get('/:slug/admin/testimonials', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        res.render('admin/pages/model-testimonials', {
            layout: 'admin/layouts/main',
            pageTitle: 'Testimonials',
            currentPage: 'model-testimonials',
            isModelAdmin: true,
            model: rows[0]
        });
    } catch (err) {
        res.status(500).send('Failed to render testimonials');
    }
});

// Model Admin: Themes page
app.get('/:slug/admin/themes', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        res.render('admin/pages/model-themes', {
            layout: 'admin/layouts/main',
            pageTitle: 'Color Themes',
            currentPage: 'model-themes',
            isModelAdmin: true,
            model: rows[0]
        });
    } catch (err) {
        res.status(500).send('Failed to render themes');
    }
});

// Model Admin: Image Library page
app.get('/:slug/admin/images', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        res.render('admin/pages/model-image-library', {
            layout: 'admin/layouts/main',
            pageTitle: 'Image Library',
            currentPage: 'model-images',
            isModelAdmin: true,
            model: rows[0]
        });
    } catch (err) {
        res.status(500).send('Failed to render image library');
    }
});

// Model Admin: Calendar page
app.get('/:slug/admin/calendar', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        res.render('admin/pages/model-calendar', {
            layout: 'admin/layouts/main',
            pageTitle: 'Calendar Management',
            currentPage: 'model-calendar',
            isModelAdmin: true,
            model: rows[0]
        });
    } catch (err) {
        res.status(500).send('Failed to render calendar');
    }
});

// Routes
app.get('/', (req, res) => {
    res.json({
        name: 'phoenix4ge API',
        version: '1.0.0',
        status: 'Running',
        message: 'Professional model portfolio management system'
    });
});

// Onboarding page
app.get('/onboarding', (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'onboarding.html'));
});

// Test impersonation page  
app.get('/admin/test-impersonation.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'test-impersonation.html'));
});

// Test upload page for AI moderation
app.get('/test-upload.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'test-upload.html'));
});

app.get('/test-db-flow.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'test', 'db-flow.html'));
});

// New route for cleaner URL
app.get('/test/db-flow', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public', 'test', 'db-flow.html'));
});

// Alternative test route to bypass caching
app.get('/test/pipeline-fresh', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public', 'test', 'db-flow.html'));
});

// Test Basic Theme Route
app.get('/test-basic', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Basic Example',
            modelSlug: model.slug || 'basic-test',
            modelId: model.id,
            pageTitle: 'Home',
            metaDescription: 'Professional and elegant design',
            ogImage: '/assets/theme-previews/basic.jpg',
            tagline: 'Professional excellence and quality service',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#1F2937',
                    secondary: '#374151', 
                    accent: '#10B981',
                    text: '#111827',
                    background: '#FFFFFF'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-basic', active: true },
                { name: 'About', url: '/test-basic/about', active: false },
                { name: 'Gallery', url: '/test-basic/gallery', active: false },
                { name: 'Services', url: '/test-basic/rates', active: false },
                { name: 'Contact', url: '/test-basic/contact', active: false }
            ],
            content: {
                heroTitle: `Welcome to ${model.name}`,
                heroSubtitle: 'Quality service with a personal touch, tailored to your needs',
                aboutPreview: 'I provide professional, high-quality services with attention to detail and a commitment to excellence. Every interaction is handled with the utmost care and professionalism.',
                servicesPreview: 'Professional services designed to meet your specific needs with quality and reliability',
                ctaTitle: 'Ready to Get Started?',
                ctaSubtitle: 'Let\'s discuss how I can help you achieve your goals'
            },
            services: [
                {
                    name: 'Professional Consultation',
                    description: 'Personalized consultation services',
                    icon: 'fas fa-handshake',
                    price: 200
                },
                {
                    name: 'Premium Experience',
                    description: 'Enhanced service with premium features',
                    icon: 'fas fa-star',
                    price: 350
                },
                {
                    name: 'Executive Package',
                    description: 'Comprehensive executive-level service',
                    icon: 'fas fa-briefcase',
                    price: 500
                }
            ],
            galleryImages: [
                { thumbnail: '/assets/placeholder-basic-1.jpg', fullSize: '/assets/placeholder-basic-1-full.jpg', caption: 'Professional Setting' },
                { thumbnail: '/assets/placeholder-basic-2.jpg', fullSize: '/assets/placeholder-basic-2-full.jpg', caption: 'Quality Service' },
                { thumbnail: '/assets/placeholder-basic-3.jpg', fullSize: '/assets/placeholder-basic-3-full.jpg', caption: 'Attention to Detail' },
                { thumbnail: '/assets/placeholder-basic-4.jpg', fullSize: '/assets/placeholder-basic-4-full.jpg', caption: 'Professional Excellence' }
            ],
            contactEmail: model.email || 'contact@basicexample.com',
            contactPhone: '(555) 123-4567',
            location: 'Professional District, Business City',
            workingHours: 'Monday - Friday: 9:00 AM - 6:00 PM',
            socialLinks: [
                { icon: 'linkedin', url: 'https://linkedin.com/in/basicexample' },
                { icon: 'twitter', url: 'https://twitter.com/basicexample' }
            ]
        };
        
        res.render('basic/pages/home', {
            layout: 'basic/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-basic:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Basic Theme - About Page
app.get('/test-basic/about', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Basic Example',
            modelSlug: model.slug || 'basic-test',
            modelId: model.id,
            pageTitle: 'About',
            metaDescription: 'Learn more about professional services',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#1F2937',
                    secondary: '#374151', 
                    accent: '#10B981',
                    text: '#111827',
                    background: '#FFFFFF'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-basic', active: false },
                { name: 'About', url: '/test-basic/about', active: true },
                { name: 'Gallery', url: '/test-basic/gallery', active: false },
                { name: 'Services', url: '/test-basic/rates', active: false },
                { name: 'Contact', url: '/test-basic/contact', active: false }
            ],
            content: {
                aboutIntro: 'Get to know me and my professional approach to service',
                mainContent: '<p>I am dedicated to providing exceptional, professional services with a focus on quality and attention to detail. My approach is centered on understanding and meeting the unique needs of each client.</p><p>With years of experience in providing personalized services, I pride myself on maintaining the highest standards of professionalism and discretion.</p>',
                personalInfo: [
                    { icon: 'fas fa-map-marker-alt', label: 'Location', value: 'Professional District' },
                    { icon: 'fas fa-language', label: 'Languages', value: 'English, Spanish' },
                    { icon: 'fas fa-star', label: 'Experience', value: '5+ Years' }
                ],
                values: [
                    { icon: 'fas fa-handshake', title: 'Professionalism', description: 'Maintaining the highest standards in every interaction' },
                    { icon: 'fas fa-lock', title: 'Discretion', description: 'Complete confidentiality and privacy for all clients' },
                    { icon: 'fas fa-heart', title: 'Quality', description: 'Exceptional service tailored to individual needs' }
                ]
            }
        };
        
        res.render('basic/pages/about', {
            layout: 'basic/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-basic/about:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Basic Theme - Contact Page
app.get('/test-basic/contact', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Basic Example',
            modelSlug: model.slug || 'basic-test',
            modelId: model.id,
            pageTitle: 'Contact',
            metaDescription: 'Get in touch for professional services',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#1F2937',
                    secondary: '#374151', 
                    accent: '#10B981',
                    text: '#111827',
                    background: '#FFFFFF'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-basic', active: false },
                { name: 'About', url: '/test-basic/about', active: false },
                { name: 'Gallery', url: '/test-basic/gallery', active: false },
                { name: 'Services', url: '/test-basic/rates', active: false },
                { name: 'Contact', url: '/test-basic/contact', active: true }
            ],
            content: {
                contactIntro: 'Ready to discuss your needs? Get in touch today'
            },
            contactEmail: model.email || 'contact@basicexample.com',
            contactPhone: '(555) 123-4567',
            location: 'Professional District, Business City',
            workingHours: 'Monday - Friday: 9:00 AM - 6:00 PM',
            socialLinks: [
                { icon: 'linkedin', url: 'https://linkedin.com/in/basicexample' },
                { icon: 'twitter', url: 'https://twitter.com/basicexample' }
            ]
        };
        
        res.render('basic/pages/contact', {
            layout: 'basic/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-basic/contact:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Basic Theme - Services/Rates Page
app.get('/test-basic/rates', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Basic Example',
            modelSlug: model.slug || 'basic-test',
            modelId: model.id,
            pageTitle: 'Services & Rates',
            metaDescription: 'Professional services and pricing information',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#1F2937',
                    secondary: '#374151', 
                    accent: '#10B981',
                    text: '#111827',
                    background: '#FFFFFF'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-basic', active: false },
                { name: 'About', url: '/test-basic/about', active: false },
                { name: 'Gallery', url: '/test-basic/gallery', active: false },
                { name: 'Services', url: '/test-basic/rates', active: true },
                { name: 'Contact', url: '/test-basic/contact', active: false }
            ],
            content: {
                ratesIntro: 'Professional services designed to meet your specific needs',
                advanceBooking: 'I recommend booking at least 24-48 hours in advance to ensure availability',
                paymentPolicy: 'Payment accepted via cash, major credit cards, or electronic transfer',
                cancellationPolicy: 'Cancellations require 4+ hours notice to avoid fees'
            },
            services: [
                {
                    name: 'Professional Consultation',
                    description: 'Personalized consultation and advisory services',
                    icon: 'fas fa-handshake',
                    price: 200,
                    duration: '1 hour',
                    features: ['Personalized approach', 'Professional setting', 'Confidential consultation']
                },
                {
                    name: 'Premium Experience',
                    description: 'Enhanced service with premium features and extended time',
                    icon: 'fas fa-star',
                    price: 350,
                    duration: '2 hours',
                    features: ['Extended consultation', 'Premium amenities', 'Flexible scheduling']
                },
                {
                    name: 'Executive Package',
                    description: 'Comprehensive executive-level service with full support',
                    icon: 'fas fa-briefcase',
                    price: 500,
                    duration: '3+ hours',
                    features: ['Executive treatment', 'Complete privacy', 'Custom arrangements']
                }
            ]
        };
        
        res.render('basic/pages/rates', {
            layout: 'basic/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-basic/rates:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Basic Theme - Gallery Page
app.get('/test-basic/gallery', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Basic Example',
            modelSlug: model.slug || 'basic-test',
            modelId: model.id,
            pageTitle: 'Gallery',
            metaDescription: 'Professional photo gallery',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#1F2937',
                    secondary: '#374151', 
                    accent: '#10B981',
                    text: '#111827',
                    background: '#FFFFFF'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-basic', active: false },
                { name: 'About', url: '/test-basic/about', active: false },
                { name: 'Gallery', url: '/test-basic/gallery', active: true },
                { name: 'Services', url: '/test-basic/rates', active: false },
                { name: 'Contact', url: '/test-basic/contact', active: false }
            ],
            content: {
                galleryIntro: 'A collection of professional photos showcasing quality and professionalism'
            },
            galleryImages: [
                { thumbnail: '/assets/placeholder-basic-1.jpg', fullSize: '/assets/placeholder-basic-1-full.jpg', caption: 'Professional Setting', category: 'professional' },
                { thumbnail: '/assets/placeholder-basic-2.jpg', fullSize: '/assets/placeholder-basic-2-full.jpg', caption: 'Quality Service', category: 'professional' },
                { thumbnail: '/assets/placeholder-basic-3.jpg', fullSize: '/assets/placeholder-basic-3-full.jpg', caption: 'Attention to Detail', category: 'professional' },
                { thumbnail: '/assets/placeholder-basic-4.jpg', fullSize: '/assets/placeholder-basic-4-full.jpg', caption: 'Professional Excellence', category: 'professional' }
            ]
        };
        
        res.render('basic/pages/gallery', {
            layout: 'basic/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-basic/gallery:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Glamour Theme Route
app.get('/test-glamour', (req, res) => {
    const testData = {
        siteName: 'Glamour Example',
        modelSlug: 'glamour-test',
        modelId: 1,
        pageTitle: 'Home',
        metaDescription: 'Sophisticated glamour and elegance',
        ogImage: '/assets/theme-previews/glamour.jpg',
        tagline: 'Sophistication meets elegance',
        currentYear: new Date().getFullYear(),
        theme: {
            colors: {
                primary: '#EC4899',
                secondary: '#BE185D', 
                accent: '#F59E0B',
                text: '#831843',
                background: '#FDF2F8'
            }
        },
        navigation: [
            { name: 'Home', url: '/test-glamour', active: true },
            { name: 'About', url: '/test-glamour/about', active: false },
            { name: 'Gallery', url: '/test-glamour/gallery', active: false },
            { name: 'Services', url: '/test-glamour/rates', active: false },
            { name: 'Contact', url: '/test-glamour/contact', active: false }
        ],
        content: {
            heroTitle: 'Welcome to Glamour',
            heroSubtitle: 'Experience sophistication and elegance like never before',
            aboutPreview: 'Discover a world of luxury and refinement. I offer an exclusive experience tailored to the most discerning clientele, where every detail is crafted to perfection.',
            servicesPreview: 'Exclusive experiences designed for those who appreciate the finer things in life',
            ctaTitle: 'Ready for an Unforgettable Experience?',
            ctaSubtitle: 'Let\'s create something extraordinary together'
        },
        services: [
            {
                name: 'Dinner Companion',
                description: 'Elegant dining experiences at the finest establishments',
                icon: 'fas fa-wine-glass',
                price: 500
            },
            {
                name: 'Social Events',
                description: 'Sophisticated companionship for special occasions',
                icon: 'fas fa-champagne-glasses',
                price: 750
            },
            {
                name: 'Weekend Getaway',
                description: 'Luxurious travel experiences to exotic destinations',
                icon: 'fas fa-plane',
                price: 2500
            }
        ],
        contactEmail: 'hello@glamourtest.com',
        contactPhone: '+1 (555) 123-4567',
        location: 'Los Angeles, CA'
    };
    
    res.render('glamour/pages/home', {
        layout: 'glamour/layouts/main',
        ...testData
    });
});

// Test Glamour Theme - About Page
app.get('/test-glamour/about', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Glamour Example',
            modelSlug: model.slug || 'glamour-test',
            modelId: model.id,
            pageTitle: 'About',
            metaDescription: 'Discover sophistication and elegance',
            ogImage: '/assets/theme-previews/glamour.jpg',
            tagline: 'Sophistication meets elegance',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#EC4899',
                    secondary: '#BE185D', 
                    accent: '#F59E0B',
                    text: '#831843',
                    background: '#FDF2F8'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-glamour', active: false },
                { name: 'About', url: '/test-glamour/about', active: true },
                { name: 'Gallery', url: '/test-glamour/gallery', active: false },
                { name: 'Services', url: '/test-glamour/rates', active: false },
                { name: 'Contact', url: '/test-glamour/contact', active: false }
            ],
            content: {
                aboutIntro: 'Discover the woman behind the glamour and sophistication',
                mainContent: '<p>I embody elegance, sophistication, and refined taste in everything I do. My approach is centered on creating unforgettable experiences that blend luxury with genuine connection.</p><p>With a passion for the finer things in life and an appreciation for true quality, I provide an exclusive experience for those who demand nothing but the best.</p>',
                personalInfo: [
                    { icon: 'fas fa-map-marker-alt', label: 'Location', value: 'Upscale District' },
                    { icon: 'fas fa-language', label: 'Languages', value: 'English, French, Italian' },
                    { icon: 'fas fa-star', label: 'Experience', value: 'Elite Level' }
                ],
                values: [
                    { icon: 'fas fa-gem', title: 'Luxury', description: 'Every moment crafted with exquisite attention to detail' },
                    { icon: 'fas fa-mask', title: 'Discretion', description: 'Absolute confidentiality and sophisticated privacy' },
                    { icon: 'fas fa-heart', title: 'Elegance', description: 'Refined experiences that exceed expectations' }
                ]
            }
        };
        
        res.render('glamour/pages/about', {
            layout: 'glamour/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-glamour/about:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Glamour Theme - Contact Page
app.get('/test-glamour/contact', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Glamour Example',
            modelSlug: model.slug || 'glamour-test',
            modelId: model.id,
            pageTitle: 'Contact',
            metaDescription: 'Connect for an exclusive experience',
            ogImage: '/assets/theme-previews/glamour.jpg',
            tagline: 'Sophistication meets elegance',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#EC4899',
                    secondary: '#BE185D', 
                    accent: '#F59E0B',
                    text: '#831843',
                    background: '#FDF2F8'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-glamour', active: false },
                { name: 'About', url: '/test-glamour/about', active: false },
                { name: 'Gallery', url: '/test-glamour/gallery', active: false },
                { name: 'Services', url: '/test-glamour/rates', active: false },
                { name: 'Contact', url: '/test-glamour/contact', active: true }
            ],
            content: {
                contactIntro: 'Ready for an unforgettable experience? Let\'s connect'
            },
            contactEmail: model.email || 'contact@glamourexample.com',
            contactPhone: '(555) 987-6543',
            location: 'Exclusive Upscale District',
            workingHours: 'By Appointment Only - 24/7',
            socialLinks: [
                { icon: 'instagram', url: 'https://instagram.com/glamourexample' },
                { icon: 'twitter', url: 'https://twitter.com/glamourexample' }
            ]
        };
        
        res.render('glamour/pages/contact', {
            layout: 'glamour/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-glamour/contact:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Glamour Theme - Services/Rates Page
app.get('/test-glamour/rates', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Glamour Example',
            modelSlug: model.slug || 'glamour-test',
            modelId: model.id,
            pageTitle: 'Services & Rates',
            metaDescription: 'Exclusive services and premium experiences',
            ogImage: '/assets/theme-previews/glamour.jpg',
            tagline: 'Sophistication meets elegance',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#EC4899',
                    secondary: '#BE185D', 
                    accent: '#F59E0B',
                    text: '#831843',
                    background: '#FDF2F8'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-glamour', active: false },
                { name: 'About', url: '/test-glamour/about', active: false },
                { name: 'Gallery', url: '/test-glamour/gallery', active: false },
                { name: 'Services', url: '/test-glamour/rates', active: true },
                { name: 'Contact', url: '/test-glamour/contact', active: false }
            ],
            content: {
                ratesIntro: 'Exclusive experiences designed for discerning clientele',
                advanceBooking: 'Advance booking required - minimum 48 hours notice for premium experiences',
                paymentPolicy: 'Discrete payment options available including premium arrangements',
                cancellationPolicy: 'Sophisticated cancellation policy - 24 hours notice appreciated'
            },
            services: [
                {
                    name: 'Sophisticated Companionship',
                    description: 'Elegant companionship for upscale events and occasions',
                    icon: 'fas fa-gem',
                    price: 500,
                    duration: '2 hours',
                    features: ['Premium experience', 'Sophisticated conversation', 'Elegant presence']
                },
                {
                    name: 'Luxury Experience',
                    description: 'Exclusive luxury experience with personalized attention',
                    icon: 'fas fa-crown',
                    price: 800,
                    duration: '3 hours',
                    features: ['VIP treatment', 'Luxury amenities', 'Bespoke experience']
                },
                {
                    name: 'Elite Package',
                    description: 'The ultimate in sophistication and exclusivity',
                    icon: 'fas fa-star',
                    price: 1200,
                    duration: '4+ hours',
                    features: ['Elite status', 'Ultimate luxury', 'Exclusive arrangements']
                }
            ],
            packages: [
                {
                    name: 'Weekend Getaway',
                    description: 'A sophisticated weekend escape',
                    price: 2500,
                    originalPrice: 3000,
                    popular: true,
                    includes: ['Luxury accommodations', 'Fine dining experiences', 'Premium companionship', 'Exclusive activities']
                }
            ]
        };
        
        res.render('glamour/pages/rates', {
            layout: 'glamour/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-glamour/rates:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Glamour Theme - Gallery Page
app.get('/test-glamour/gallery', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Glamour Example',
            modelSlug: model.slug || 'glamour-test',
            modelId: model.id,
            pageTitle: 'Gallery',
            metaDescription: 'Sophisticated glamour photography',
            ogImage: '/assets/theme-previews/glamour.jpg',
            tagline: 'Sophistication meets elegance',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#EC4899',
                    secondary: '#BE185D', 
                    accent: '#F59E0B',
                    text: '#831843',
                    background: '#FDF2F8'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-glamour', active: false },
                { name: 'About', url: '/test-glamour/about', active: false },
                { name: 'Gallery', url: '/test-glamour/gallery', active: true },
                { name: 'Services', url: '/test-glamour/rates', active: false },
                { name: 'Contact', url: '/test-glamour/contact', active: false }
            ],
            content: {
                galleryIntro: 'A curated collection showcasing sophistication and elegance'
            },
            galleryImages: [
                { thumbnail: '/assets/placeholder-glamour-1.jpg', fullSize: '/assets/placeholder-glamour-1-full.jpg', caption: 'Sophisticated Elegance', category: 'glamour' },
                { thumbnail: '/assets/placeholder-glamour-2.jpg', fullSize: '/assets/placeholder-glamour-2-full.jpg', caption: 'Luxury Lifestyle', category: 'glamour' },
                { thumbnail: '/assets/placeholder-glamour-3.jpg', fullSize: '/assets/placeholder-glamour-3-full.jpg', caption: 'Refined Beauty', category: 'glamour' },
                { thumbnail: '/assets/placeholder-glamour-4.jpg', fullSize: '/assets/placeholder-glamour-4-full.jpg', caption: 'Elite Sophistication', category: 'glamour' },
                { thumbnail: '/assets/placeholder-glamour-5.jpg', fullSize: '/assets/placeholder-glamour-5-full.jpg', caption: 'Timeless Grace', category: 'glamour' },
                { thumbnail: '/assets/placeholder-glamour-6.jpg', fullSize: '/assets/placeholder-glamour-6-full.jpg', caption: 'Premium Experience', category: 'glamour' }
            ],
            galleryStats: {
                totalPhotos: '50+',
                categories: '5',
                lastUpdated: 'Weekly',
                featured: '12'
            }
        };
        
        res.render('glamour/pages/gallery', {
            layout: 'glamour/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-glamour/gallery:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Luxury Theme - Home Page
app.get('/test-luxury', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Luxury Example',
            modelSlug: model.slug || 'luxury-test',
            modelId: model.id,
            pageTitle: 'Home',
            metaDescription: 'The pinnacle of luxury and sophistication',
            ogImage: '/assets/theme-previews/luxury.jpg',
            tagline: 'The pinnacle of luxury and sophistication',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#8B5A2B',
                    secondary: '#CD853F', 
                    accent: '#FFD700',
                    text: '#2C1810',
                    background: '#FFFFFF'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-luxury', active: true },
                { name: 'About', url: '/test-luxury/about', active: false },
                { name: 'Gallery', url: '/test-luxury/gallery', active: false },
                { name: 'Services', url: '/test-luxury/rates', active: false },
                { name: 'Contact', url: '/test-luxury/contact', active: false }
            ],
            content: {
                heroTitle: `Welcome to ${model.name}`,
                heroSubtitle: 'Experience the pinnacle of luxury and sophistication',
                aboutPreview: 'I represent the ultimate in luxury experiences, where every detail is crafted to perfection. My services cater to the most discerning clientele who appreciate true quality and sophistication.',
                servicesPreview: 'Exclusive luxury experiences designed for those who demand nothing but the finest',
                ctaTitle: 'Ready for Ultimate Luxury?',
                ctaSubtitle: 'Experience sophistication at its finest. Let\'s create something extraordinary together.'
            },
            services: [
                {
                    name: 'Platinum Companionship',
                    description: 'Ultimate luxury companionship for exclusive events',
                    icon: 'fas fa-crown',
                    price: 1000
                },
                {
                    name: 'Diamond Experience',
                    description: 'The finest luxury experience with personalized service',
                    icon: 'fas fa-gem',
                    price: 1500
                },
                {
                    name: 'Royal Treatment',
                    description: 'The absolute pinnacle of luxury and sophistication',
                    icon: 'fas fa-chess-queen',
                    price: 2000
                }
            ],
            galleryImages: [
                { thumbnail: '/assets/placeholder-luxury-1.jpg', fullSize: '/assets/placeholder-luxury-1-full.jpg', caption: 'Ultimate Luxury', category: 'luxury' },
                { thumbnail: '/assets/placeholder-luxury-2.jpg', fullSize: '/assets/placeholder-luxury-2-full.jpg', caption: 'Sophisticated Elegance', category: 'luxury' },
                { thumbnail: '/assets/placeholder-luxury-3.jpg', fullSize: '/assets/placeholder-luxury-3-full.jpg', caption: 'Premium Experience', category: 'luxury' },
                { thumbnail: '/assets/placeholder-luxury-4.jpg', fullSize: '/assets/placeholder-luxury-4-full.jpg', caption: 'Royal Treatment', category: 'luxury' }
            ],
            contactEmail: model.email || 'contact@luxuryexample.com',
            contactPhone: '(555) 999-8888',
            location: 'Exclusive Luxury District',
            workingHours: 'By Exclusive Appointment Only',
            socialLinks: [
                { icon: 'instagram', url: 'https://instagram.com/luxuryexample' },
                { icon: 'twitter', url: 'https://twitter.com/luxuryexample' }
            ]
        };
        
        res.render('luxury/pages/home', {
            layout: 'luxury/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-luxury:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Luxury Theme - About Page
app.get('/test-luxury/about', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Luxury Example',
            modelSlug: model.slug || 'luxury-test',
            modelId: model.id,
            pageTitle: 'About',
            metaDescription: 'Discover the pinnacle of luxury and sophistication',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#8B5A2B',
                    secondary: '#CD853F', 
                    accent: '#FFD700',
                    text: '#2C1810',
                    background: '#FFFFFF'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-luxury', active: false },
                { name: 'About', url: '/test-luxury/about', active: true },
                { name: 'Gallery', url: '/test-luxury/gallery', active: false },
                { name: 'Services', url: '/test-luxury/rates', active: false },
                { name: 'Contact', url: '/test-luxury/contact', active: false }
            ],
            content: {
                aboutIntro: 'Discover the epitome of luxury and refined sophistication',
                mainContent: '<p>I embody the very essence of luxury, offering experiences that transcend ordinary expectations. Every interaction is a masterpiece of sophistication, crafted with meticulous attention to detail and an unwavering commitment to excellence.</p><p>My clientele consists of the most discerning individuals who understand and appreciate true luxury. I provide not just a service, but an art form - where elegance, discretion, and unparalleled quality converge to create unforgettable moments.</p>',
                personalInfo: [
                    { icon: 'fas fa-map-marker-alt', label: 'Location', value: 'Exclusive Luxury District' },
                    { icon: 'fas fa-language', label: 'Languages', value: 'English, French, Italian, German' },
                    { icon: 'fas fa-star', label: 'Experience', value: 'Platinum Level' }
                ],
                values: [
                    { icon: 'fas fa-crown', title: 'Royal Treatment', description: 'Every client receives treatment befitting royalty' },
                    { icon: 'fas fa-shield-alt', title: 'Ultimate Discretion', description: 'Complete privacy and confidentiality guaranteed' },
                    { icon: 'fas fa-gem', title: 'Perfection', description: 'Nothing less than absolute perfection in every detail' }
                ]
            }
        };
        
        res.render('luxury/pages/about', {
            layout: 'luxury/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-luxury/about:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Luxury Theme - Contact Page
app.get('/test-luxury/contact', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Luxury Example',
            modelSlug: model.slug || 'luxury-test',
            modelId: model.id,
            pageTitle: 'Contact',
            metaDescription: 'Connect for the ultimate luxury experience',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#8B5A2B',
                    secondary: '#CD853F', 
                    accent: '#FFD700',
                    text: '#2C1810',
                    background: '#FFFFFF'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-luxury', active: false },
                { name: 'About', url: '/test-luxury/about', active: false },
                { name: 'Gallery', url: '/test-luxury/gallery', active: false },
                { name: 'Services', url: '/test-luxury/rates', active: false },
                { name: 'Contact', url: '/test-luxury/contact', active: true }
            ],
            content: {
                contactIntro: 'Ready for the ultimate luxury experience? Let\'s connect'
            },
            contactEmail: model.email || 'contact@luxuryexample.com',
            contactPhone: '(555) 999-8888',
            location: 'Exclusive Luxury District',
            workingHours: 'By Exclusive Appointment Only',
            socialLinks: [
                { icon: 'instagram', url: 'https://instagram.com/luxuryexample' },
                { icon: 'twitter', url: 'https://twitter.com/luxuryexample' }
            ]
        };
        
        res.render('luxury/pages/contact', {
            layout: 'luxury/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-luxury/contact:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Luxury Theme - Services/Rates Page
app.get('/test-luxury/rates', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Luxury Example',
            modelSlug: model.slug || 'luxury-test',
            modelId: model.id,
            pageTitle: 'Luxury Services & Rates',
            metaDescription: 'Ultimate luxury services and premium experiences',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#8B5A2B',
                    secondary: '#CD853F', 
                    accent: '#FFD700',
                    text: '#2C1810',
                    background: '#FFFFFF'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-luxury', active: false },
                { name: 'About', url: '/test-luxury/about', active: false },
                { name: 'Gallery', url: '/test-luxury/gallery', active: false },
                { name: 'Services', url: '/test-luxury/rates', active: true },
                { name: 'Contact', url: '/test-luxury/contact', active: false }
            ],
            content: {
                ratesIntro: 'Ultimate luxury experiences for the most discerning clientele',
                advanceBooking: 'Exclusive appointments require minimum 72 hours advance notice',
                paymentPolicy: 'Premium payment arrangements with complete discretion',
                cancellationPolicy: 'Luxury cancellation policy - 48 hours notice required'
            },
            services: [
                {
                    name: 'Platinum Companionship',
                    description: 'Ultimate luxury companionship for exclusive events',
                    icon: 'fas fa-crown',
                    price: 1000,
                    duration: '3 hours',
                    features: ['Royal treatment', 'Exclusive experience', 'Ultimate discretion']
                },
                {
                    name: 'Diamond Experience',
                    description: 'The finest luxury experience with personalized service',
                    icon: 'fas fa-gem',
                    price: 1500,
                    duration: '4 hours',
                    features: ['Personalized luxury', 'Premium amenities', 'VIP treatment']
                },
                {
                    name: 'Royal Treatment',
                    description: 'The absolute pinnacle of luxury and sophistication',
                    icon: 'fas fa-chess-queen',
                    price: 2000,
                    duration: '5+ hours',
                    features: ['Ultimate luxury', 'Royal experience', 'Perfection guaranteed']
                }
            ],
            packages: [
                {
                    name: 'Luxury Weekend Escape',
                    description: 'The ultimate luxury weekend experience',
                    price: 5000,
                    originalPrice: 6000,
                    popular: true,
                    includes: ['Luxury accommodations', 'Fine dining experiences', 'Premium companionship', 'Exclusive activities', 'Personal concierge service']
                }
            ]
        };
        
        res.render('luxury/pages/rates', {
            layout: 'luxury/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-luxury/rates:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Luxury Theme - Gallery Page
app.get('/test-luxury/gallery', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Luxury Example',
            modelSlug: model.slug || 'luxury-test',
            modelId: model.id,
            pageTitle: 'Luxury Gallery',
            metaDescription: 'Ultimate luxury photography and exclusive content',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#8B5A2B',
                    secondary: '#CD853F', 
                    accent: '#FFD700',
                    text: '#2C1810',
                    background: '#FFFFFF'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-luxury', active: false },
                { name: 'About', url: '/test-luxury/about', active: false },
                { name: 'Gallery', url: '/test-luxury/gallery', active: true },
                { name: 'Services', url: '/test-luxury/rates', active: false },
                { name: 'Contact', url: '/test-luxury/contact', active: false }
            ],
            content: {
                galleryIntro: 'A curated collection of the finest luxury photography'
            },
            galleryImages: [
                { thumbnail: '/assets/placeholder-luxury-1.jpg', fullSize: '/assets/placeholder-luxury-1-full.jpg', caption: 'Ultimate Luxury', category: 'luxury' },
                { thumbnail: '/assets/placeholder-luxury-2.jpg', fullSize: '/assets/placeholder-luxury-2-full.jpg', caption: 'Sophisticated Elegance', category: 'luxury' },
                { thumbnail: '/assets/placeholder-luxury-3.jpg', fullSize: '/assets/placeholder-luxury-3-full.jpg', caption: 'Premium Experience', category: 'luxury' },
                { thumbnail: '/assets/placeholder-luxury-4.jpg', fullSize: '/assets/placeholder-luxury-4-full.jpg', caption: 'Royal Treatment', category: 'luxury' },
                { thumbnail: '/assets/placeholder-luxury-5.jpg', fullSize: '/assets/placeholder-luxury-5-full.jpg', caption: 'Platinum Service', category: 'luxury' },
                { thumbnail: '/assets/placeholder-luxury-6.jpg', fullSize: '/assets/placeholder-luxury-6-full.jpg', caption: 'Diamond Quality', category: 'luxury' }
            ],
            galleryStats: {
                totalPhotos: '100+',
                categories: '8',
                lastUpdated: 'Daily',
                featured: '20'
            }
        };
        
        res.render('luxury/pages/gallery', {
            layout: 'luxury/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-luxury/gallery:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Modern Theme Routes
app.get('/test-modern', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Modern Example',
            modelSlug: model.slug || 'modern-test',
            modelId: model.id,
            pageTitle: 'Home',
            metaDescription: 'Contemporary design meets professional service',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#2563EB',
                    secondary: '#1E40AF',
                    accent: '#06B6D4',
                    text: '#1F2937',
                    background: '#FFFFFF'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-modern', active: true },
                { name: 'About', url: '/test-modern/about', active: false },
                { name: 'Gallery', url: '/test-modern/gallery', active: false },
                { name: 'Services', url: '/test-modern/rates', active: false },
                { name: 'Contact', url: '/test-modern/contact', active: false }
            ],
            content: {
                heroTitle: `Welcome to ${model.name}`,
                heroSubtitle: 'Modern, professional services delivered with contemporary style',
                aboutPreview: 'I provide contemporary, efficient services with a focus on modern solutions and professional excellence. My approach combines cutting-edge methods with reliable, personalized service.',
                servicesPreview: 'Modern services designed for today\'s needs with efficiency and style',
                ctaTitle: 'Ready to Start?',
                ctaSubtitle: 'Let\'s create something modern and professional together'
            },
            services: [
                {
                    name: 'Modern Consultation',
                    description: 'Contemporary consultation services with modern approach',
                    icon: 'fas fa-laptop',
                    price: 150
                },
                {
                    name: 'Professional Service',
                    description: 'Efficient professional service with modern standards',
                    icon: 'fas fa-cogs',
                    price: 250
                },
                {
                    name: 'Premium Package',
                    description: 'Complete modern service package with all features',
                    icon: 'fas fa-rocket',
                    price: 400
                }
            ],
            galleryImages: [
                { thumbnail: '/assets/placeholder-modern-1.jpg', fullSize: '/assets/placeholder-modern-1-full.jpg', caption: 'Modern Design', category: 'modern' },
                { thumbnail: '/assets/placeholder-modern-2.jpg', fullSize: '/assets/placeholder-modern-2-full.jpg', caption: 'Professional Work', category: 'modern' },
                { thumbnail: '/assets/placeholder-modern-3.jpg', fullSize: '/assets/placeholder-modern-3-full.jpg', caption: 'Contemporary Style', category: 'modern' },
                { thumbnail: '/assets/placeholder-modern-4.jpg', fullSize: '/assets/placeholder-modern-4-full.jpg', caption: 'Efficient Solutions', category: 'modern' }
            ],
            contactEmail: model.email || 'contact@modernexample.com',
            contactPhone: '(555) 123-0000',
            location: 'Modern Business District',
            workingHours: 'Flexible Hours - Contact to Schedule',
            socialLinks: [
                { icon: 'linkedin', url: 'https://linkedin.com/in/modernexample' },
                { icon: 'twitter', url: 'https://twitter.com/modernexample' }
            ]
        };
        
        res.render('modern/pages/home', {
            layout: 'modern/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-modern:', error);
        res.status(500).send('Internal server error');
    }
});

app.get('/test-modern/about', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Modern Example',
            modelSlug: model.slug || 'modern-test',
            modelId: model.id,
            pageTitle: 'About',
            metaDescription: 'Learn about modern professional services',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#2563EB',
                    secondary: '#1E40AF',
                    accent: '#06B6D4',
                    text: '#1F2937',
                    background: '#FFFFFF'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-modern', active: false },
                { name: 'About', url: '/test-modern/about', active: true },
                { name: 'Gallery', url: '/test-modern/gallery', active: false },
                { name: 'Services', url: '/test-modern/rates', active: false },
                { name: 'Contact', url: '/test-modern/contact', active: false }
            ],
            content: {
                aboutIntro: 'Discover modern professional services with contemporary approach',
                mainContent: '<p>I specialize in modern, efficient service delivery using contemporary methods and professional standards. My approach combines innovation with reliability to provide exceptional results.</p><p>With a focus on current trends and modern solutions, I deliver services that meet today\'s demands while maintaining the highest professional standards.</p>',
                personalInfo: [
                    { icon: 'fas fa-map-marker-alt', label: 'Location', value: 'Modern Business District' },
                    { icon: 'fas fa-code', label: 'Specialties', value: 'Modern Solutions' },
                    { icon: 'fas fa-star', label: 'Experience', value: 'Professional Level' }
                ],
                values: [
                    { icon: 'fas fa-rocket', title: 'Innovation', description: 'Using modern methods and contemporary approaches' },
                    { icon: 'fas fa-shield-alt', title: 'Reliability', description: 'Consistent, professional service delivery' },
                    { icon: 'fas fa-cogs', title: 'Efficiency', description: 'Streamlined processes for optimal results' }
                ]
            }
        };
        
        res.render('modern/pages/about', {
            layout: 'modern/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-modern/about:', error);
        res.status(500).send('Internal server error');
    }
});

app.get('/test-modern/contact', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Modern Example',
            modelSlug: model.slug || 'modern-test',
            modelId: model.id,
            pageTitle: 'Contact',
            metaDescription: 'Connect for modern professional services',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#2563EB',
                    secondary: '#1E40AF',
                    accent: '#06B6D4',
                    text: '#1F2937',
                    background: '#FFFFFF'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-modern', active: false },
                { name: 'About', url: '/test-modern/about', active: false },
                { name: 'Gallery', url: '/test-modern/gallery', active: false },
                { name: 'Services', url: '/test-modern/rates', active: false },
                { name: 'Contact', url: '/test-modern/contact', active: true }
            ],
            content: {
                contactIntro: 'Ready to experience modern professional service? Let\'s connect'
            },
            contactEmail: model.email || 'contact@modernexample.com',
            contactPhone: '(555) 123-0000',
            location: 'Modern Business District',
            workingHours: 'Flexible Hours - Contact to Schedule',
            socialLinks: [
                { icon: 'linkedin', url: 'https://linkedin.com/in/modernexample' },
                { icon: 'twitter', url: 'https://twitter.com/modernexample' }
            ]
        };
        
        res.render('modern/pages/contact', {
            layout: 'modern/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-modern/contact:', error);
        res.status(500).send('Internal server error');
    }
});

app.get('/test-modern/rates', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Modern Example',
            modelSlug: model.slug || 'modern-test',
            modelId: model.id,
            pageTitle: 'Services & Rates',
            metaDescription: 'Modern professional services and competitive rates',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#2563EB',
                    secondary: '#1E40AF',
                    accent: '#06B6D4',
                    text: '#1F2937',
                    background: '#FFFFFF'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-modern', active: false },
                { name: 'About', url: '/test-modern/about', active: false },
                { name: 'Gallery', url: '/test-modern/gallery', active: false },
                { name: 'Services', url: '/test-modern/rates', active: true },
                { name: 'Contact', url: '/test-modern/contact', active: false }
            ],
            content: {
                ratesIntro: 'Modern services with competitive rates and flexible options',
                advanceBooking: 'Flexible scheduling - book 24-48 hours in advance for best availability',
                paymentPolicy: 'Multiple payment options available including digital payments',
                cancellationPolicy: 'Modern cancellation policy - 24 hours notice appreciated'
            },
            services: [
                {
                    name: 'Modern Consultation',
                    description: 'Contemporary consultation services with modern approach',
                    icon: 'fas fa-laptop',
                    price: 150,
                    duration: '1 hour',
                    features: ['Modern methods', 'Professional approach', 'Flexible scheduling']
                },
                {
                    name: 'Professional Service',
                    description: 'Efficient professional service with modern standards',
                    icon: 'fas fa-cogs',
                    price: 250,
                    duration: '2 hours',
                    features: ['Contemporary approach', 'Efficient delivery', 'Professional standards']
                },
                {
                    name: 'Premium Package',
                    description: 'Complete modern service package with all features',
                    icon: 'fas fa-rocket',
                    price: 400,
                    duration: '3+ hours',
                    features: ['Complete package', 'All modern features', 'Premium support']
                }
            ]
        };
        
        res.render('modern/pages/rates', {
            layout: 'modern/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-modern/rates:', error);
        res.status(500).send('Internal server error');
    }
});

app.get('/test-modern/gallery', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Modern Example',
            modelSlug: model.slug || 'modern-test',
            modelId: model.id,
            pageTitle: 'Portfolio',
            metaDescription: 'Modern portfolio showcasing contemporary work',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#2563EB',
                    secondary: '#1E40AF',
                    accent: '#06B6D4',
                    text: '#1F2937',
                    background: '#FFFFFF'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-modern', active: false },
                { name: 'About', url: '/test-modern/about', active: false },
                { name: 'Gallery', url: '/test-modern/gallery', active: true },
                { name: 'Services', url: '/test-modern/rates', active: false },
                { name: 'Contact', url: '/test-modern/contact', active: false }
            ],
            content: {
                galleryIntro: 'A modern portfolio showcasing contemporary professional work'
            },
            galleryImages: [
                { thumbnail: '/assets/placeholder-modern-1.jpg', fullSize: '/assets/placeholder-modern-1-full.jpg', caption: 'Modern Design', category: 'modern' },
                { thumbnail: '/assets/placeholder-modern-2.jpg', fullSize: '/assets/placeholder-modern-2-full.jpg', caption: 'Professional Work', category: 'modern' },
                { thumbnail: '/assets/placeholder-modern-3.jpg', fullSize: '/assets/placeholder-modern-3-full.jpg', caption: 'Contemporary Style', category: 'modern' },
                { thumbnail: '/assets/placeholder-modern-4.jpg', fullSize: '/assets/placeholder-modern-4-full.jpg', caption: 'Efficient Solutions', category: 'modern' },
                { thumbnail: '/assets/placeholder-modern-5.jpg', fullSize: '/assets/placeholder-modern-5-full.jpg', caption: 'Modern Approach', category: 'modern' },
                { thumbnail: '/assets/placeholder-modern-6.jpg', fullSize: '/assets/placeholder-modern-6-full.jpg', caption: 'Professional Results', category: 'modern' }
            ],
            galleryStats: {
                totalPhotos: '50+',
                categories: '4',
                lastUpdated: 'Weekly',
                featured: '10'
            }
        };
        
        res.render('modern/pages/gallery', {
            layout: 'modern/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-modern/gallery:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Dark Theme Route
app.get('/test-dark', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Dark Example',
            modelSlug: model.slug || 'dark-test',
            modelId: model.id,
            pageTitle: 'Home',
            metaDescription: 'Cutting-edge dark theme with neon accents',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#00ff88',
                    secondary: '#00cc6a',
                    accent: '#ff0088',
                    text: '#ffffff',
                    background: '#0a0a0a'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-dark', active: true },
                { name: 'About', url: '/test-dark/about', active: false },
                { name: 'Gallery', url: '/test-dark/gallery', active: false },
                { name: 'Services', url: '/test-dark/rates', active: false },
                { name: 'Contact', url: '/test-dark/contact', active: false }
            ],
            content: {
                heroTitle: `${model.name}`,
                heroSubtitle: 'Next-generation professional services with cutting-edge approach',
                aboutPreview: 'Innovative solutions combined with professional excellence. Modern approach to traditional service delivery.',
                servicesPreview: 'Advanced services utilizing cutting-edge methodologies and professional standards',
                ctaTitle: 'Ready to Get Started?',
                ctaSubtitle: 'Let\'s discuss your project and bring your vision to life with professional expertise.'
            },
            features: [
                { icon: 'fas fa-rocket', title: 'Innovation', description: 'Cutting-edge solutions for modern challenges' },
                { icon: 'fas fa-shield-alt', title: 'Reliability', description: 'Consistent, professional service delivery' },
                { icon: 'fas fa-users', title: 'Personalized', description: 'Tailored experiences for every client' }
            ],
            stats: {
                experience: '5+',
                clients: '200+',
                projects: '500+',
                satisfaction: '99'
            },
            services: [
                { 
                    icon: 'fas fa-star', 
                    name: 'Premium Service', 
                    description: 'High-end professional service with personalized attention',
                    price: 299.99,
                    slug: 'premium'
                },
                { 
                    icon: 'fas fa-diamond', 
                    name: 'Exclusive Package', 
                    description: 'Elite service package with comprehensive features',
                    price: 499.99,
                    slug: 'exclusive'
                },
                { 
                    icon: 'fas fa-crown', 
                    name: 'VIP Experience', 
                    description: 'Ultimate professional experience with full customization',
                    price: 799.99,
                    slug: 'vip'
                }
            ]
        };
        
        res.render('dark/pages/home', {
            layout: 'dark/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-dark:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Dark Theme - About Page
app.get('/test-dark/about', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Dark Example',
            modelSlug: model.slug || 'dark-test',
            modelId: model.id,
            pageTitle: 'About',
            metaDescription: 'Learn about cutting-edge professional services',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#00ff88',
                    secondary: '#00cc6a',
                    accent: '#ff0088',
                    text: '#ffffff',
                    background: '#0a0a0a'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-dark', active: false },
                { name: 'About', url: '/test-dark/about', active: true },
                { name: 'Gallery', url: '/test-dark/gallery', active: false },
                { name: 'Services', url: '/test-dark/rates', active: false },
                { name: 'Contact', url: '/test-dark/contact', active: false }
            ],
            content: {
                aboutIntro: 'Discover the future of professional service delivery',
                mainContent: '<p>I specialize in next-generation professional services that combine cutting-edge innovation with traditional excellence. My approach integrates modern methodologies with time-tested principles of quality and reliability.</p><p>With expertise in advanced service delivery systems and a commitment to pushing boundaries, I provide solutions that are both forward-thinking and professionally sound.</p>',
                personalInfo: [
                    { icon: 'fas fa-code', label: 'Specialization', value: 'Advanced Systems' },
                    { icon: 'fas fa-globe', label: 'Reach', value: 'Global Network' },
                    { icon: 'fas fa-certificate', label: 'Certified', value: 'Industry Leader' }
                ],
                values: [
                    { icon: 'fas fa-rocket', title: 'Innovation', description: 'Pushing boundaries with cutting-edge solutions' },
                    { icon: 'fas fa-lock', title: 'Security', description: 'Advanced encryption and privacy protection' },
                    { icon: 'fas fa-lightning-bolt', title: 'Efficiency', description: 'Streamlined processes for optimal results' }
                ],
                experience: [
                    { icon: 'fas fa-graduation-cap', title: 'Advanced Training', period: '2020-2023', description: 'Specialized certification in next-generation service methodologies' },
                    { icon: 'fas fa-award', title: 'Industry Recognition', period: '2021-Present', description: 'Multiple awards for innovation in professional service delivery' },
                    { icon: 'fas fa-network-wired', title: 'System Integration', period: '2022-Present', description: 'Expert in advanced integration and automation systems' }
                ]
            }
        };
        
        res.render('dark/pages/about', {
            layout: 'dark/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-dark/about:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Dark Theme - Contact Page
app.get('/test-dark/contact', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Dark Example',
            modelSlug: model.slug || 'dark-test',
            modelId: model.id,
            pageTitle: 'Contact',
            metaDescription: 'Get in touch for cutting-edge solutions',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#00ff88',
                    secondary: '#00cc6a',
                    accent: '#ff0088',
                    text: '#ffffff',
                    background: '#0a0a0a'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-dark', active: false },
                { name: 'About', url: '/test-dark/about', active: false },
                { name: 'Gallery', url: '/test-dark/gallery', active: false },
                { name: 'Services', url: '/test-dark/rates', active: false },
                { name: 'Contact', url: '/test-dark/contact', active: true }
            ],
            content: {
                contactIntro: 'Connect with next-generation professional services'
            },
            contactEmail: 'contact@darkexample.com',
            contactPhone: '+1 (555) 123-4567',
            location: 'Innovation District',
            workingHours: '24/7 Digital Availability',
            socialLinks: [
                { icon: 'linkedin', url: 'https://linkedin.com/in/darkexample' },
                { icon: 'twitter', url: 'https://twitter.com/darkexample' },
                { icon: 'github', url: 'https://github.com/darkexample' }
            ]
        };
        
        res.render('dark/pages/contact', {
            layout: 'dark/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-dark/contact:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Dark Theme - Rates Page
app.get('/test-dark/rates', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Dark Example',
            modelSlug: model.slug || 'dark-test',
            modelId: model.id,
            pageTitle: 'Services & Rates',
            metaDescription: 'Advanced professional services and pricing',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#00ff88',
                    secondary: '#00cc6a',
                    accent: '#ff0088',
                    text: '#ffffff',
                    background: '#0a0a0a'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-dark', active: false },
                { name: 'About', url: '/test-dark/about', active: false },
                { name: 'Gallery', url: '/test-dark/gallery', active: false },
                { name: 'Services', url: '/test-dark/rates', active: true },
                { name: 'Contact', url: '/test-dark/contact', active: false }
            ],
            content: {
                ratesIntro: 'Next-generation services with competitive pricing',
                advanceBooking: '48-hour advance booking recommended for optimal service scheduling',
                paymentPolicy: 'Secure digital payments accepted. Cryptocurrency options available.',
                cancellationPolicy: '24-hour cancellation policy with automated refund processing'
            },
            services: [
                { 
                    icon: 'fas fa-star', 
                    name: 'Premium Service', 
                    description: 'High-end professional service with advanced features and personalized attention',
                    duration: '2-3 hours',
                    price: 299.99,
                    features: ['Advanced consultation', 'Custom solutions', 'Priority support', '24/7 availability'],
                    slug: 'premium'
                },
                { 
                    icon: 'fas fa-diamond', 
                    name: 'Exclusive Package', 
                    description: 'Elite service package with comprehensive features and cutting-edge tools',
                    duration: '4-6 hours',
                    price: 499.99,
                    features: ['Full system integration', 'Advanced analytics', 'Custom automation', 'Dedicated support'],
                    slug: 'exclusive'
                },
                { 
                    icon: 'fas fa-crown', 
                    name: 'VIP Experience', 
                    description: 'Ultimate professional experience with full customization and innovation',
                    duration: 'Full day',
                    price: 799.99,
                    features: ['Complete system overhaul', 'AI-powered solutions', 'Real-time monitoring', 'White-glove service'],
                    slug: 'vip'
                }
            ],
            packages: [
                {
                    name: 'Innovation Bundle',
                    price: 999.99,
                    originalPrice: 1299.99,
                    popular: true,
                    description: 'Complete package with all premium features',
                    includes: ['All premium services', 'Advanced AI integration', 'Custom development', '6-month support'],
                    slug: 'innovation'
                },
                {
                    name: 'Enterprise Solution',
                    price: 1999.99,
                    description: 'Full enterprise-grade implementation',
                    includes: ['Enterprise architecture', 'Team training', 'Custom integrations', '12-month support'],
                    slug: 'enterprise'
                }
            ]
        };
        
        res.render('dark/pages/rates', {
            layout: 'dark/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-dark/rates:', error);
        res.status(500).send('Internal server error');
    }
});

// Test Dark Theme - Gallery Page
app.get('/test-dark/gallery', async (req, res) => {
    try {
        const modelId = 1;
        const [modelRows] = await db.execute('SELECT * FROM models WHERE id = ?', [modelId]);
        
        if (modelRows.length === 0) {
            return res.status(404).send('Model not found');
        }
        
        const model = modelRows[0];
        
        const testData = {
            siteName: model.name || 'Dark Example',
            modelSlug: model.slug || 'dark-test',
            modelId: model.id,
            pageTitle: 'Portfolio',
            metaDescription: 'Showcase of cutting-edge professional work',
            currentYear: new Date().getFullYear(),
            theme: {
                colors: {
                    primary: '#00ff88',
                    secondary: '#00cc6a',
                    accent: '#ff0088',
                    text: '#ffffff',
                    background: '#0a0a0a'
                }
            },
            navigation: [
                { name: 'Home', url: '/test-dark', active: false },
                { name: 'About', url: '/test-dark/about', active: false },
                { name: 'Gallery', url: '/test-dark/gallery', active: true },
                { name: 'Services', url: '/test-dark/rates', active: false },
                { name: 'Contact', url: '/test-dark/contact', active: false }
            ],
            content: {
                galleryIntro: 'Explore innovative solutions and cutting-edge implementations',
                hasMoreImages: true
            },
            galleryCategories: [
                { name: 'Systems', slug: 'systems' },
                { name: 'Innovation', slug: 'innovation' },
                { name: 'Solutions', slug: 'solutions' }
            ],
            galleryImages: [
                { thumbnail: '/assets/gallery/thumb1.jpg', fullSize: '/assets/gallery/full1.jpg', caption: 'Advanced System Integration', category: 'systems' },
                { thumbnail: '/assets/gallery/thumb2.jpg', fullSize: '/assets/gallery/full2.jpg', caption: 'Innovation Framework', category: 'innovation' },
                { thumbnail: '/assets/gallery/thumb3.jpg', fullSize: '/assets/gallery/full3.jpg', caption: 'Custom Solution Architecture', category: 'solutions' },
                { thumbnail: '/assets/gallery/thumb4.jpg', fullSize: '/assets/gallery/full4.jpg', caption: 'AI-Powered Analytics', category: 'systems' },
                { thumbnail: '/assets/gallery/thumb5.jpg', fullSize: '/assets/gallery/full5.jpg', caption: 'Next-Gen Interface Design', category: 'innovation' },
                { thumbnail: '/assets/gallery/thumb6.jpg', fullSize: '/assets/gallery/full6.jpg', caption: 'Enterprise Implementation', category: 'solutions' }
            ],
            galleryStats: {
                totalPhotos: '150+',
                categories: '8',
                lastUpdated: 'Weekly',
                featured: '25'
            }
        };
        
        res.render('dark/pages/gallery', {
            layout: 'dark/layouts/main',
            ...testData
        });
    } catch (error) {
        console.error('Error loading test-dark/gallery:', error);
        res.status(500).send('Internal server error');
    }
});

// Real NudeNet file upload test page
app.get('/test-file-upload.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'test-file-upload.html'));
});

// Real analysis demo page
app.get('/demo-real-analysis.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'demo-real-analysis.html'));
});

// Admin content review tool
app.get('/admin-content-review.html', (req, res) => {
    if (process.env.NODE_ENV !== 'production') {
        return res.redirect('/sysadmin');
    }
    res.sendFile(path.join(__dirname, 'admin-content-review.html'));
});

// Admin content review tool (with /admin prefix)
app.get('/admin/admin-content-review.html', (req, res) => {
    if (process.env.NODE_ENV !== 'production') {
        return res.redirect('/sysadmin');
    }
    res.sendFile(path.join(__dirname, 'admin-content-review.html'));
});

// AI Server Management admin page
app.get('/admin/ai-server-management.html', (req, res) => {
    if (process.env.NODE_ENV !== 'production') {
        return res.redirect('/sysadmin');
    }
    res.sendFile(path.join(__dirname, 'admin', 'ai-server-management.html'));
});

// Site Configuration Management admin page
app.get('/admin/site-configuration.html', (req, res) => {
    if (process.env.NODE_ENV !== 'production') {
        return res.redirect('/sysadmin');
    }
    res.sendFile(path.join(__dirname, 'admin', 'site-configuration.html'));
});

// Enhanced Site Configuration Management admin page
app.get('/admin/site-configuration-enhanced.html', (req, res) => {
    if (process.env.NODE_ENV !== 'production') {
        return res.redirect('/sysadmin');
    }
    res.sendFile(path.join(__dirname, 'admin', 'site-configuration-enhanced.html'));
});

// SMS Management admin page
app.get('/admin/sms-management.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'sms-management.html'));
});

// SMS Management shortcut route
app.get('/admin/sms', (req, res) => {
    res.redirect('/admin/sms-management.html');
});

// Admin Dashboard (main admin index)
app.get('/admin/', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

app.get('/admin/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// Enhanced moderation test page
app.get('/enhanced-moderation-test.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'enhanced-moderation-test.html'));
});

// Admin moderation dashboard
app.get('/admin-moderation-dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin-moderation-dashboard.html'));
});

// Health check
app.get('/health', async (req, res) => {
    const result = {
        status: 'OK',
        timestamp: new Date().toISOString(),
        database: 'Disconnected'
    };
    try {
        const [versionRows] = await db.execute('SELECT VERSION() as v');
        const mysqlVersion = versionRows?.[0]?.v || 'unknown';
        const tables = ['models', 'content_templates', 'theme_sets', 'media_review_queue'];
        const counts = {};
        for (const t of tables) {
            try {
                const [rows] = await db.execute(`SELECT COUNT(*) AS c FROM ${t}`);
                counts[t] = rows?.[0]?.c ?? null;
            } catch (e) {
                counts[t] = null;
            }
        }
        result.database = 'Connected';
        result.mysqlVersion = mysqlVersion;
        result.tableCounts = counts;
    } catch (e) {
        result.error = e.message;
    }
    res.json(result);
});

// Dev-only: AI health proxy
app.get('/_ai/health', async (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(404).end();
    }
    const baseUrl = process.env.AI_SERVER_URL || 'http://localhost:5005';
    try {
        const response = await axios.get(`${baseUrl.replace(/\/$/, '')}/health`, { timeout: 4000 });
        res.json({ status: 'OK', target: baseUrl, upstream: response.data });
    } catch (err) {
        res.status(503).json({ status: 'UNAVAILABLE', target: baseUrl, error: err.message });
    }
});

// Dev-only: runtime route listing (best-effort)
app.get('/_debug/routes', (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(404).end();
    }
    const collect = [];
    const stack = app._router && app._router.stack ? app._router.stack : [];

    function pushRoute(route, base = '') {
        const methods = Object.keys(route.methods || {}).filter(m => route.methods[m]).map(m => m.toUpperCase());
        const path = base + route.path;
        if (methods.length) {
            methods.forEach(method => collect.push({ method, path }));
        } else {
            collect.push({ method: 'USE', path });
        }
    }

    for (const layer of stack) {
        if (layer.route) {
            pushRoute(layer.route, '');
        } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
            // Attempt to detect base (may be regex) — we keep it empty for clarity
            const sub = layer.handle.stack;
            for (const s of sub) {
                if (s.route) {
                    pushRoute(s.route, '');
                }
            }
        }
    }

    collect.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    res.json({ count: collect.length, routes: collect });
});

// API Routes
// Auth routes - Main authentication system
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/auth', require('./src/routes/auth-verification'));
app.use('/api/auth', require('./src/routes/auth-password-reset'));
app.use('/api/auth', require('./src/routes/auth-refresh'));
app.use('/api/auth', require('./src/routes/auth-audit'));
app.use('/api/auth', require('./src/routes/auth-mfa'));
app.use('/api/auth', require('./src/routes/auth-oauth'));
app.use('/api/auth', require('./src/routes/auth-onboarding'));
app.use('/api/auth', require('./src/routes/auth-analytics'));
app.use('/api/auth-appwrite', require('./src/routes/auth-appwrite'));
app.use('/api/models', require('./src/routes/models'));
// Deprecated legacy admin API surface — removed (use /api/sysadmin)
// app.use('/api/admin', require('./src/routes/admin'));

// Content Management APIs
// Public/content APIs remain mounted as-is
app.use('/api/gallery', require('./routes/gallery'));
app.use('/api/faq', require('./routes/faq'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/testimonials', require('./routes/testimonials'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/theme-custom', require('./routes/theme-customization'));
app.use('/api/theme-sets', require('./routes/theme-sets'));
app.use('/api/onboarding', require('./routes/api/admin-onboarding'));
// Legacy admin API mounts (aliases) — keep minimal to avoid duplication
app.use('/api/admin-business', require('./routes/api/admin-system'));
app.use('/api/system-management', require('./routes/api/admin-system'));
app.use('/api/impersonation', require('./routes/api/admin-impersonation'));
app.use('/api/content-moderation', require('./routes/api/content-moderation'));
app.use('/api/enhanced-content-moderation', require('./routes/api/content-moderation-enhanced'));
app.use('/api/media-review-queue', require('./routes/api/content-review-queue'));
app.use('/api/admin-models', require('./routes/api/admin-system'));
app.use('/api/test', require('./routes/api/test'));
// Webhook routes removed - now using parallel Venice.ai processing
app.use('/api/ai-server-management', require('./routes/api/admin-system'));
app.use('/api/site-configuration', require('./routes/api/admin-system'));
app.use('/api/clients', require('./routes/api/admin-clients'));
// Model Dashboard APIs (Phase 2 - Backend Infrastructure)
app.use('/api/model-dashboard', require('./routes/api/admin-system'));
app.use('/api/media-preview', require('./routes/api/media-preview'));
app.use('/api/theme-colors', require('./routes/api/theme-colors'));
app.use('/api/color-palettes', require('./routes/api/color-palettes'));

// Contact management system
app.use('/api/contact', require('./routes/api/contact'));
app.use('/api/chat', require('./routes/api/chat'));
app.use('/api/chat-files', require('./routes/api/chat-files'));
app.use('/api/conversations', require('./routes/api/conversations'));
app.use('/api/sms', require('./routes/api/sms'));
app.use('/api/email', require('./routes/api/email'));

// Consolidated sysadmin API namespace (keeps legacy mounts above for back-compat)
app.use('/api/sysadmin', require('./routes/api/admin-system'));
// Model Admin API (per-model)
try {
  app.use('/api/model-gallery', require('./routes/api/model-gallery'));
} catch (e) {
  // ignore during scaffold if missing
}
try {
  app.use('/api/gallery-monitoring', require('./routes/api/gallery-monitoring'));
} catch (e) {
  console.warn('Gallery monitoring API not available:', e.message);
}
try {
  app.use('/api/model-media-library', require('./routes/api/media-library'));
} catch (e) {
  console.warn('Media Library API not available:', e.message);
}
try {
  app.use('/api/model-gallery-sections', require('./routes/api/gallery-sections'));
  app.use('/api/public-gallery', require('./routes/api/gallery-public'));
} catch (e) {
  console.warn('Gallery Sections API not available:', e.message);
}
try { 
  app.use('/api/quick-facts', require('./routes/api/quick-facts')); 
  console.log('✅ Quick Facts API route loaded successfully');
} catch (e) { 
  console.error('❌ Failed to load Quick Facts API route:', e.message);
}
try { app.use('/api/model-settings', require('./routes/api/model-settings')); } catch (e) {}
try { app.use('/api/model-testimonials', require('./routes/api/model-testimonials')); } catch (e) {}
try { app.use('/api/model-themes', require('./routes/api/model-themes')); } catch (e) {}
try { app.use('/api/model-theme-settings', require('./routes/api/theme-settings')); } catch (e) {}
try { app.use('/api/model-calendar', require('./routes/api/model-calendar')); } catch (e) {}
try { app.use('/api/model-profile', require('./routes/api/model-profile')); } catch (e) {}
try { app.use('/api/gallery-images', require('./routes/api/gallery-images')); } catch (e) {}
try { app.use('/api/theme-templates', require('./routes/api/theme-templates')); } catch (e) {}
try { app.use('/api/page-status', require('./routes/api/page-status')); } catch (e) {}
try { app.use('/api/content-templates', require('./routes/api/content-templates')); } catch (e) {}
try { app.use('/api/data-dump', require('./routes/api/data-dump')); } catch (e) {}

// CRM API Routes
app.use('/api/crm', require('./routes/api/crm/clients'));
app.use('/api/crm', require('./routes/api/crm/screening'));
app.use('/api/crm', require('./routes/api/crm/messages'));
app.use('/api/crm', require('./routes/api/crm/threads'));
app.use('/api/crm', require('./routes/api/crm/clients-notes'));

// External API v1 Routes (with API key authentication)
app.use('/api/v1/auth', require('./routes/api/v1/auth'));
app.use('/api/v1/clients', require('./routes/api/v1/clients'));
app.use('/api/v1/conversations', require('./routes/api/v1/conversations'));
app.use('/api/v1/messages', require('./routes/api/v1/messages'));
app.use('/api/v1/screening', require('./routes/api/v1/screening'));
app.use('/api/v1/files', require('./routes/api/v1/files'));
app.use('/api/v1/notes', require('./routes/api/v1/notes'));

// Theme Management API
app.get('/api/theme-management/models', async (req, res) => {
    try {
        const [models] = await db.execute(`
            SELECT m.id, m.name, m.slug, m.theme_set_id, m.status, m.created_at, m.updated_at,
                   ts.name as theme_name
            FROM models m
            LEFT JOIN theme_sets ts ON m.theme_set_id = ts.id
            WHERE m.status != 'inactive' 
            ORDER BY m.name ASC
        `);
        
        res.json(models);
    } catch (error) {
        console.error('Error fetching models:', error);
        res.status(500).json({ error: 'Failed to fetch models' });
    }
});

app.put('/api/theme-management/models/:id/theme', async (req, res) => {
    try {
        const { id } = req.params;
        const { theme_set_id, theme_id, primary_color, accent_color } = req.body;
        
        // Use theme_set_id directly if provided, otherwise fall back to theme_id mapping for backward compatibility
        let themeSetId = theme_set_id;
        
        if (!themeSetId && theme_id) {
            // Legacy support: Map theme names to IDs only if theme_set_id not provided
            const themeMap = {
                'basic': 1,
                'glamour': 2,
                'luxury': 3,
                'modern': 4,
                'dark': 5
            };
            
            themeSetId = themeMap[theme_id];
            if (!themeSetId) {
                return res.status(400).json({ error: 'Invalid theme ID' });
            }
        }
        
        if (!themeSetId) {
            return res.status(400).json({ error: 'No theme_set_id or theme_id provided' });
        }
        
        // Validate that the theme exists and get its default palette
        const themeData = await db.query('SELECT id, default_palette_id FROM theme_sets WHERE id = ?', [themeSetId]);
        if (themeData.length === 0) {
            return res.status(400).json({ error: 'Theme does not exist' });
        }

        const theme = themeData[0];
        
        // Update the model's theme and reset to theme's default color palette
        // This implements the two-tier system: theme change always resets to default palette
        await db.query(`
            UPDATE models 
            SET theme_set_id = ?, 
                active_color_palette_id = ?,
                updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `, [themeSetId, theme.default_palette_id, id]);
        
        // TODO: Store custom colors in a separate table if provided
        
        res.json({ 
            success: true, 
            message: 'Theme assigned successfully',
            model_id: id,
            theme_set_id: themeSetId,
            active_color_palette_id: theme.default_palette_id
        });
    } catch (error) {
        console.error('Error assigning theme:', error);
        res.status(500).json({ error: 'Failed to assign theme' });
    }
});

// Content Management API
app.get('/api/content-management/models', async (req, res) => {
    try {
        const [models] = await db.execute(`
            SELECT m.id, m.name, m.slug, m.status, m.created_at
            FROM models m
            WHERE m.status IN ('active', 'inactive', 'trial')
            ORDER BY m.name
        `);
        res.json(models);
    } catch (error) {
        console.error('Error fetching models for content management:', error);
        res.status(500).json({ error: 'Failed to fetch models' });
    }
});

app.get('/api/page-types', async (req, res) => {
    try {
        const [rows] = await db.execute(
            'SELECT id, name, display_name, description FROM page_types WHERE is_active = 1 ORDER BY name'
        );
        res.json(rows);
    } catch (error) {
        console.error('Error fetching page types:', error);
        res.status(500).json({ error: 'Failed to fetch page types' });
    }
});

app.get('/api/content/:modelId/:pageTypeId', async (req, res) => {
    try {
        const { modelId, pageTypeId } = req.params;
        
        const [rows] = await db.execute(`
            SELECT content_key, content_value 
            FROM content_templates 
            WHERE model_id = ? AND page_type_id = ?
        `, [modelId, pageTypeId]);
        
        // Convert rows to key-value object
        const content = {};
        rows.forEach(row => {
            content[row.content_key] = row.content_value;
        });
        
        content.model_id = parseInt(modelId);
        content.page_type_id = parseInt(pageTypeId);
        
        res.json(content);
    } catch (error) {
        console.error('Error fetching content:', error);
        res.status(500).json({ error: 'Failed to fetch content' });
    }
});

app.put('/api/content/:modelId/:pageTypeId', async (req, res) => {
    try {
        const { modelId, pageTypeId } = req.params;
        const contentData = req.body;
        
        // Remove model_id and page_type_id from content data
        delete contentData.model_id;
        delete contentData.page_type_id;
        
        // Update or insert each content field
        for (const [contentKey, contentValue] of Object.entries(contentData)) {
            if (contentValue !== null && contentValue !== undefined) {
                await db.execute(`
                    INSERT INTO content_templates (model_id, page_type_id, content_key, content_value, content_type, updated_at)
                    VALUES (?, ?, ?, ?, 'text', NOW())
                    ON DUPLICATE KEY UPDATE content_value = VALUES(content_value), updated_at = NOW()
                `, [modelId, pageTypeId, contentKey, contentValue]);
            }
        }
        
        res.json({ success: true, message: 'Content updated successfully' });
    } catch (error) {
        console.error('Error updating content:', error);
        res.status(500).json({ error: 'Failed to update content' });
    }
});

app.get('/api/content/:modelId/:pageTypeId/export', async (req, res) => {
    try {
        const { modelId, pageTypeId } = req.params;
        
        const [rows] = await db.execute(`
            SELECT ct.content_key, ct.content_value, m.name as model_name, m.slug as model_slug, pt.display_name as page_type
            FROM content_templates ct
            JOIN models m ON ct.model_id = m.id
            JOIN page_types pt ON ct.page_type_id = pt.id
            WHERE ct.model_id = ? AND ct.page_type_id = ?
        `, [modelId, pageTypeId]);
        
        const exportData = {
            model: rows[0]?.model_name || 'Unknown',
            slug: rows[0]?.model_slug || 'unknown',
            page_type: rows[0]?.page_type || 'Unknown',
            export_date: new Date().toISOString(),
            content: {}
        };
        
        rows.forEach(row => {
            exportData.content[row.content_key] = row.content_value;
        });
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${exportData.slug}_${exportData.page_type.toLowerCase()}_content.json"`);
        res.json(exportData);
    } catch (error) {
        console.error('Error exporting content:', error);
        res.status(500).json({ error: 'Failed to export content' });
    }
});

app.get('/api/content/statistics', async (req, res) => {
    try {
        const [contentCount] = await db.execute('SELECT COUNT(*) as total FROM content_templates');
        const [activeModels] = await db.execute('SELECT COUNT(*) as total FROM models WHERE status = "active"');
        const [pageTypes] = await db.execute('SELECT COUNT(*) as total FROM page_types WHERE is_active = 1');
        const [lastUpdated] = await db.execute('SELECT MAX(updated_at) as last_update FROM content_templates');
        
        res.json({
            totalContent: contentCount[0].total,
            activeModels: activeModels[0].total,
            pageTypes: pageTypes[0].total,
            lastUpdated: lastUpdated[0].last_update ? new Date(lastUpdated[0].last_update).toLocaleDateString() : 'Never'
        });
    } catch (error) {
        console.error('Error fetching statistics:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

// New Content API - Slug-based endpoints for content editors
const PAGE_TYPE_MAP = {
    'home': 1,
    'about': 2,  
    'contact': 3,
    'gallery': 4,
    'rates': 5,
    'etiquette': 16
};


// Get content for a specific page type by model slug
app.get('/api/model-content-new/:slug/:pageType', async (req, res) => {
    try {
        const { slug, pageType } = req.params;
        
        // Get model ID from slug
        const [modelRows] = await db.execute(
            'SELECT id FROM models WHERE slug = ? LIMIT 1',
            [slug]
        );
        
        if (!modelRows.length) {
            return res.status(404).json({ success: false, message: 'Model not found' });
        }
        
        const modelId = modelRows[0].id;
        const pageTypeId = PAGE_TYPE_MAP[pageType];
        
        if (!pageTypeId) {
            return res.status(400).json({ success: false, message: 'Invalid page type' });
        }
        
        // Get content for this page type
        const [rows] = await db.execute(`
            SELECT content_key, content_value 
            FROM content_templates 
            WHERE model_id = ? AND page_type_id = ?
        `, [modelId, pageTypeId]);
        
        // Convert rows to key-value object
        const content = {};
        rows.forEach(row => {
            content[row.content_key] = row.content_value;
        });
        
        res.json({
            success: true,
            data: content,
            modelId: modelId,
            pageTypeId: pageTypeId
        });
        
    } catch (error) {
        console.error('Error fetching model content:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch content' });
    }
});

// Update content for a specific page type by model slug
app.put('/api/model-content-new/:slug/:pageType', async (req, res) => {
    try {
        const { slug, pageType } = req.params;
        const contentData = req.body;
        
        // Get model ID from slug
        const [modelRows] = await db.execute(
            'SELECT id FROM models WHERE slug = ? LIMIT 1',
            [slug]
        );
        
        if (!modelRows.length) {
            return res.status(404).json({ success: false, message: 'Model not found' });
        }
        
        const modelId = modelRows[0].id;
        const pageTypeId = PAGE_TYPE_MAP[pageType];
        
        if (!pageTypeId) {
            return res.status(400).json({ success: false, message: 'Invalid page type' });
        }
        
        // Update or insert each content field
        for (const [contentKey, contentValue] of Object.entries(contentData)) {
            if (contentValue !== null && contentValue !== undefined) {
                await db.execute(`
                    INSERT INTO content_templates (model_id, page_type_id, content_key, content_value, content_type, updated_at)
                    VALUES (?, ?, ?, ?, 'text', NOW())
                    ON DUPLICATE KEY UPDATE content_value = VALUES(content_value), updated_at = NOW()
                `, [modelId, pageTypeId, contentKey, contentValue]);
            }
        }
        
        res.json({ success: true, message: 'Content updated successfully' });
        
    } catch (error) {
        console.error('Error updating model content:', error);
        res.status(500).json({ success: false, message: 'Failed to update content' });
    }
});



app.get('/api/theme-management/themes', async (req, res) => {
    try {
        const buildPreview = (path) => ({ url: path, embed: `${path}?embed=1` });
        
        // Fetch themes from database with default palette info
        const themeRows = await db.query(`
            SELECT 
                ts.id, 
                ts.name, 
                ts.display_name, 
                ts.description, 
                ts.default_palette_id,
                cp.name as palette_name,
                cp.display_name as palette_display_name
            FROM theme_sets ts 
            LEFT JOIN color_palettes cp ON ts.default_palette_id = cp.id
            WHERE ts.is_active = 1 
            ORDER BY ts.id ASC
        `);
        
        const themes = themeRows.map(theme => {
            // Get basic color info from palette (for compatibility)
            let colors = {
                primary: '#007bff',
                secondary: '#6c757d',
                accent: '#28a745'
            };
            
            // Note: Full color loading now handled by color palette API
            console.log(`Theme ${theme.name} uses palette: ${theme.palette_name}`);
            
            return {
                id: theme.id,  // Use numeric ID from database
                name: theme.display_name || theme.name,
                description: theme.description,
                primary_color: colors.primary || '#3B82F6',
                accent_color: colors.accent || colors.secondary || '#10B981',
                preview: buildPreview(`/test-${theme.name}`)
            };
        });
        
        res.json({ success: true, data: { themes } });
    } catch (error) {
        console.error('Error fetching themes:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch themes' });
    }
});

// GET /api/theme-management/gallery-assignments - Get theme gallery assignments
app.get('/api/theme-management/gallery-assignments', async (req, res) => {
    try {
        const [assignments] = await db.execute(`
            SELECT tga.theme_id, tga.gallery_profile_id, tga.is_default_profile, tga.display_order,
                   gp.profile_name, gp.profile_display_name, gp.layout_type
            FROM theme_gallery_assignments tga
            JOIN gallery_profiles gp ON tga.gallery_profile_id = gp.id
            WHERE tga.is_active = 1
            ORDER BY tga.theme_id ASC, tga.display_order ASC
        `);
        
        // Group by theme_id and return array of assignments per theme
        const assignmentMap = {};
        assignments.forEach(assignment => {
            if (!assignmentMap[assignment.theme_id]) {
                assignmentMap[assignment.theme_id] = [];
            }
            assignmentMap[assignment.theme_id].push({
                gallery_profile_id: assignment.gallery_profile_id,
                profile_name: assignment.profile_name,
                profile_display_name: assignment.profile_display_name,
                layout_type: assignment.layout_type,
                is_default_profile: assignment.is_default_profile,
                display_order: assignment.display_order
            });
        });
        
        res.json(assignmentMap);
    } catch (error) {
        console.error('Error fetching theme gallery assignments:', error);
        // If table doesn't exist yet, return empty object
        res.json({});
    }
});

// POST /api/theme-management/gallery-assignments/add - Add gallery profiles to theme
app.post('/api/theme-management/gallery-assignments/add', async (req, res) => {
    try {
        const { theme_id, gallery_profile_ids } = req.body;
        
        if (!theme_id || !Array.isArray(gallery_profile_ids) || gallery_profile_ids.length === 0) {
            return res.status(400).json({
                error: 'Invalid request',
                message: 'Theme ID and gallery profile IDs array are required'
            });
        }
        
        // Verify all gallery profiles exist
        const [profileCheck] = await db.execute(
            `SELECT id FROM gallery_profiles WHERE id IN (${gallery_profile_ids.map(() => '?').join(',')})`,
            gallery_profile_ids
        );
        
        if (profileCheck.length !== gallery_profile_ids.length) {
            return res.status(400).json({
                error: 'Invalid gallery profiles',
                message: 'One or more gallery profiles not found'
            });
        }
        
        // Get next display order
        const [maxOrder] = await db.execute(
            'SELECT COALESCE(MAX(display_order), 0) as max_order FROM theme_gallery_assignments WHERE theme_id = ? AND is_active = 1',
            [theme_id]
        );
        
        let nextOrder = (maxOrder[0].max_order || 0) + 1;
        
        // Add assignments
        for (const profileId of gallery_profile_ids) {
            await db.execute(`
                INSERT INTO theme_gallery_assignments (theme_id, gallery_profile_id, display_order, is_active, created_at, updated_at)
                VALUES (?, ?, ?, 1, NOW(), NOW())
                ON DUPLICATE KEY UPDATE 
                    is_active = 1,
                    display_order = ?,
                    updated_at = NOW()
            `, [theme_id, profileId, nextOrder, nextOrder]);
            nextOrder++;
        }
        
        res.json({
            success: true,
            message: `Added ${gallery_profile_ids.length} gallery profile(s) to theme`,
            theme_id: theme_id,
            added_profiles: gallery_profile_ids
        });
        
    } catch (error) {
        console.error('Error adding gallery assignments:', error);
        res.status(500).json({
            error: 'Failed to add assignments',
            message: error.message
        });
    }
});

// POST /api/theme-management/gallery-assignments/remove - Remove gallery profile from theme
app.post('/api/theme-management/gallery-assignments/remove', async (req, res) => {
    try {
        const { theme_id, gallery_profile_id } = req.body;
        
        if (!theme_id || !gallery_profile_id) {
            return res.status(400).json({
                error: 'Missing parameters',
                message: 'Theme ID and gallery profile ID are required'
            });
        }
        
        // Remove assignment
        await db.execute(`
            UPDATE theme_gallery_assignments 
            SET is_active = 0, updated_at = NOW()
            WHERE theme_id = ? AND gallery_profile_id = ?
        `, [theme_id, gallery_profile_id]);
        
        res.json({
            success: true,
            message: 'Gallery profile removed from theme',
            theme_id: theme_id,
            gallery_profile_id: gallery_profile_id
        });
        
    } catch (error) {
        console.error('Error removing gallery assignment:', error);
        res.status(500).json({
            error: 'Failed to remove assignment',
            message: error.message
        });
    }
});

// POST /api/theme-management/gallery-assignments/default - Set default gallery profile for theme
app.post('/api/theme-management/gallery-assignments/default', async (req, res) => {
    try {
        const { theme_id, gallery_profile_id } = req.body;
        
        if (!theme_id || !gallery_profile_id) {
            return res.status(400).json({
                error: 'Missing parameters',
                message: 'Theme ID and gallery profile ID are required'
            });
        }
        
        // Clear existing defaults for this theme
        await db.execute(
            'UPDATE theme_gallery_assignments SET is_default_profile = 0, updated_at = NOW() WHERE theme_id = ?',
            [theme_id]
        );
        
        // Set new default
        await db.execute(
            'UPDATE theme_gallery_assignments SET is_default_profile = 1, updated_at = NOW() WHERE theme_id = ? AND gallery_profile_id = ? AND is_active = 1',
            [theme_id, gallery_profile_id]
        );
        
        res.json({
            success: true,
            message: 'Default gallery profile updated',
            theme_id: theme_id,
            gallery_profile_id: gallery_profile_id
        });
        
    } catch (error) {
        console.error('Error setting default gallery:', error);
        res.status(500).json({
            error: 'Failed to set default',
            message: error.message
        });
    }
});

// POST /api/theme-management/gallery-assignments/bulk - Save multiple assignments at once
app.post('/api/theme-management/gallery-assignments/bulk', async (req, res) => {
    try {
        const { assignments } = req.body;
        
        if (!Array.isArray(assignments)) {
            return res.status(400).json({
                error: 'Invalid assignments data',
                message: 'Assignments must be an array'
            });
        }
        
        // Begin transaction
        await db.beginTransaction();
        
        try {
            // Clear existing assignments
            await db.execute('UPDATE theme_gallery_assignments SET is_active = 0, updated_at = NOW()');
            
            // Insert new assignments
            for (const assignment of assignments) {
                await db.execute(`
                    INSERT INTO theme_gallery_assignments (theme_id, gallery_profile_id, is_active, created_at, updated_at)
                    VALUES (?, ?, 1, NOW(), NOW())
                    ON DUPLICATE KEY UPDATE 
                        gallery_profile_id = VALUES(gallery_profile_id),
                        is_active = 1,
                        updated_at = NOW()
                `, [assignment.theme_id, assignment.gallery_profile_id]);
            }
            
            await db.commit();
            
            res.json({
                success: true,
                message: `Successfully saved ${assignments.length} gallery assignments`,
                assignments_count: assignments.length
            });
            
        } catch (error) {
            await db.rollback();
            throw error;
        }
        
    } catch (error) {
        console.error('Error saving bulk gallery assignments:', error);
        res.status(500).json({
            error: 'Failed to save assignments',
            message: error.message
        });
    }
});

// GET /api/theme-management/themes/:id/css - Get theme-specific CSS
app.get('/api/theme-management/themes/:id/css', async (req, res) => {
    try {
        const { id } = req.params;
        
        const [cssData] = await db.execute(`
            SELECT custom_css FROM theme_customizations 
            WHERE theme_id = ? AND is_active = 1
        `, [id]);
        
        const css = cssData.length > 0 ? cssData[0].custom_css : '';
        
        res.json({
            success: true,
            theme_id: id,
            css: css
        });
        
    } catch (error) {
        console.error('Error fetching theme CSS:', error);
        res.json({
            success: true,
            theme_id: req.params.id,
            css: '' // Return empty CSS on error
        });
    }
});

// PUT /api/theme-management/themes/:id/css - Save theme-specific CSS
app.put('/api/theme-management/themes/:id/css', async (req, res) => {
    try {
        const { id } = req.params;
        const { css } = req.body;
        
        // Create or update CSS customization
        await db.execute(`
            INSERT INTO theme_customizations (theme_id, custom_css, is_active, created_at, updated_at)
            VALUES (?, ?, 1, NOW(), NOW())
            ON DUPLICATE KEY UPDATE 
                custom_css = VALUES(custom_css),
                updated_at = NOW()
        `, [id, css || '']);
        
        res.json({
            success: true,
            message: 'Theme CSS saved successfully',
            theme_id: id
        });
        
    } catch (error) {
        console.error('Error saving theme CSS:', error);
        res.status(500).json({
            error: 'Failed to save CSS',
            message: error.message
        });
    }
});

// Analysis Configuration API (for remote NudeNet/BLIP settings management)

// Analysis Configuration API (for remote NudeNet/BLIP settings management)
const apiKeyAuth = new ApiKeyAuth(db);
const analysisConfigAPI = new AnalysisConfigAPI(db, apiKeyAuth);
app.use('/api/v1/analysis', analysisConfigAPI.getRouter());

// Model Admin: Gallery Routes (must come before catch-all route)
app.get('/:slug/admin/gallery', async (req, res) => {
    try {
        const { slug } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        res.render('admin/pages/model-gallery', {
            layout: 'admin/layouts/main',
            pageTitle: 'Gallery Manager',
            currentPage: 'model-gallery',
            isModelAdmin: true,
            model: rows[0],
            legacyBanner: { message: 'This is a legacy admin surface. System admin lives at /sysadmin.' }
        });
    } catch (e) {
        console.error('❌ Error loading model gallery page:', e);
        res.status(500).send('Error loading model gallery');
    }
});

// Model Admin: Individual Gallery Section Management
app.get('/:slug/admin/gallery/:sectionId', async (req, res) => {
    try {
        const { slug, sectionId } = req.params;
        const rows = await db.query(
            `SELECT id, name, slug FROM models WHERE slug = ? LIMIT 1`,
            [slug]
        );
        if (!rows || !rows.length) return res.status(404).send('Model not found');
        
        // Get section details
        const sectionRows = await db.query(
            `SELECT id, title, layout_type, is_visible, layout_settings FROM gallery_sections WHERE id = ? AND model_id = ? LIMIT 1`,
            [sectionId, rows[0].id]
        );
        if (!sectionRows || !sectionRows.length) return res.status(404).send('Gallery section not found');
        
        res.render('admin/pages/gallery-section-manager', {
            layout: 'admin/layouts/main',
            pageTitle: `Gallery Manager - ${sectionRows[0].title}`,
            currentPage: 'gallery-section-manager',
            isModelAdmin: true,
            model: rows[0],
            section: sectionRows[0],
            modelSlug: slug
        });
    } catch (e) {
        console.error('❌ Error loading gallery section manager:', e);
        res.status(500).send('Error loading gallery section manager');
    }
});

// Calendar visibility middleware for model routes
const calendarVisibilityMiddleware = require('./middleware/calendarVisibility');

// CRM Routes (must come before catch-all model_sites route)
app.use('/:slug/crm', (req, res, next) => {
    // Store the slug in req for CRM routes to access
    req.crmSlug = req.params.slug;
    next();
}, require('./routes/crm'));

// Model Sites (Handlebars Themes with Real Content) - MOVED TO END
// This catches all remaining routes, so it must be last before 404 handler
app.use('/', calendarVisibilityMiddleware, require('./src/routes/model_sites'));

// 404 handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Not Found',
        message: 'The requested resource could not be found.'
    });
});

// Error handler
app.use((err, req, res, next) => {
    const logger = require('./utils/logger');
    const statusCode = err.status || 500;
    const message = statusCode === 500 ? 'Internal Server Error' : err.message || 'Error';
    const details = process.env.NODE_ENV === 'development' ? (err.stack || err.message) : undefined;
    logger.error('unhandled error', { requestId: req.id, statusCode, error: err.message });
    if (res.headersSent) return next(err);
    if (typeof res.fail === 'function') return res.fail(statusCode, message, details);
    const payload = { success: false, error: message };
    if (details) payload.details = details;
    res.status(statusCode).json(payload);
});

// Start server
async function startServer() {
    try {
        // Test database connection
        console.log('🔍 Testing database connection...');
        const dbConnected = await testConnection();

        if (!dbConnected) {
            console.warn('⚠️  Database connection failed, but server will still start');
        }

        // Start Email Queue Processor
        console.log('📧 Starting Email Queue Processor...');
        try {
            const emailQueueProcessor = require('./src/services/EmailQueueProcessor');
            emailQueueProcessor.start();
        } catch (error) {
            console.warn('⚠️  Email Queue Processor failed to start:', error.message);
        }

        // Initialize Universal Gallery System
        console.log('🎨 Initializing Universal Gallery System...');
        try {
            const GalleryHelpers = require('./src/helpers/GalleryHelpers');
            const galleryHelpers = new GalleryHelpers(db);
            await galleryHelpers.initialize();
            
            // Get the Handlebars instance from the engine
            const handlebarsEngine = app.get('view engine');
            const handlebars = require('handlebars');
            
            // Register the universal gallery helpers
            galleryHelpers.registerHelpers(handlebars);
            
            // Register universal page helpers
            const UniversalPageHelpers = require('./src/helpers/UniversalPageHelpers');
            const universalPageHelpers = new UniversalPageHelpers();
            universalPageHelpers.registerHelpers(handlebars);
            
            // Load universal partials
            const TemplateUtils = require('./utils/templateUtils');
            await TemplateUtils.loadUniversalPartials();
            
            // Load shared partials (including universal-icon)
            await TemplateUtils.loadSharedPartials();
            
            // Register the times helper for testimonial stars
            handlebars.registerHelper('times', function(n, options) {
                let result = '';
                for (let i = 0; i < n; i++) {
                    result += options.fn(this);
                }
                return result;
            });
            
            // Register the lt (less than) helper for testimonial count limiting
            handlebars.registerHelper('lt', function(a, b) {
                return a < b;
            });
            
            // Register the subtract helper for star ratings
            handlebars.registerHelper('subtract', function(a, b) {
                return a - b;
            });
            
            // Register the limit helper for testimonials
            handlebars.registerHelper('limit', function(array, limit) {
                if (!Array.isArray(array)) return [];
                return array.slice(0, limit || array.length);
            });
            
            // Register the multiply helper for AOS delays
            handlebars.registerHelper('multiply', function(a, b) {
                return a * b;
            });
            
            // Register the chatWidget helper for universal chat widget
            const ChatWidgetHelper = require('./services/ChatWidgetHelper');
            handlebars.registerHelper('chatWidget', ChatWidgetHelper.createHandlebarsHelper());
            
            console.log('✅ Universal Gallery System initialized successfully');
        } catch (error) {
            console.error('❌ Failed to initialize Universal Gallery System:', error.message);
            console.warn('⚠️  Gallery system disabled, falling back to legacy helpers');
        }
        
        // Test route for chat widget
        app.get('/test-chat-widget.html', (req, res) => {
            res.sendFile(path.join(__dirname, 'test-chat-widget.html'));
        });

        // Quick API to enable chat for testing
        app.post('/api/enable-chat-test', async (req, res) => {
            try {
                await db.execute("UPDATE models SET chat_enabled = 1 WHERE slug = 'modelexample'");
                res.json({ success: true, message: 'Chat enabled for modelexample' });
            } catch (error) {
                res.json({ success: false, error: error.message });
            }
        });
        
        // Server Configuration - Use HTTP for development, HTTPS for production
        if (process.env.NODE_ENV === 'production') {
            // HTTPS Configuration for production
            const httpsOptions = {
                key: fs.readFileSync('/etc/ssl/phoenix4ge/origin.key'),
                cert: fs.readFileSync('/etc/ssl/phoenix4ge/origin.cert')
            };

            https.createServer(httpsOptions, app).listen(PORT, () => {
                console.log('🚀 Phoenix4GE Server Started with HTTPS');
                console.log(`📍 Server running on port ${PORT}`);
                console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
                console.log(`🔗 Health check: https://localhost:${PORT}/health`);
            });
        } else {
            // HTTP Configuration for development
            app.listen(PORT, () => {
                console.log('🚀 Phoenix4GE Server Started (Development Mode - HTTP)');
                console.log(`📍 Server running on port ${PORT}`);
                console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
                console.log(`🔗 Health check: http://localhost:${PORT}/health`);
                console.log(`🔗 Access: http://localhost:${PORT}/`);
                console.log('');
                console.log('Next steps:');
                console.log('1. Copy .env.example to .env and configure your database');
                console.log('2. Run: npm run migrate (to set up database)');
                console.log('3. Run: npm run seed (to add sample data)');
            });
        }
        
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    startServer();
}

module.exports = app;