const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

/**
 * Session-based authentication middleware for HTML pages
 * Uses JWT tokens stored in cookies or Authorization header
 */
async function requireAuth(req, res, next) {
    try {
        // Get token from cookie, header, or query parameter
        let token = null;

        // 1. Check Authorization header
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7);
        }

        // 2. Check cookie
        if (!token && req.cookies && req.cookies.accessToken) {
            token = req.cookies.accessToken;
        }

        // 3. Check query parameter (for redirects)
        if (!token && req.query.token) {
            token = req.query.token;
        }

        if (!token) {
            // No token found - redirect to login
            return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
        }

        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Check if user exists and is active
        const users = await query(
            'SELECT id, email, role, is_active FROM users WHERE id = ?',
            [decoded.id]
        );

        if (users.length === 0 || !users[0].is_active) {
            return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}&error=invalid_user`);
        }

        // Attach user to request
        req.user = users[0];

        next();

    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            // Token expired - redirect to login with message
            return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}&error=token_expired`);
        }

        if (error.name === 'JsonWebTokenError') {
            // Invalid token - redirect to login
            return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}&error=invalid_token`);
        }

        console.error('Authentication error:', error);
        return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}&error=auth_error`);
    }
}

/**
 * Require model access - user must be owner/admin of the model
 */
async function requireModelAccess(req, res, next) {
    try {
        const { slug } = req.params;
        const userId = req.user.id;

        // Get model by slug
        const models = await query(
            'SELECT id FROM models WHERE slug = ?',
            [slug]
        );

        if (models.length === 0) {
            return res.status(404).send('Model not found');
        }

        const modelId = models[0].id;

        // Check if user has access to this model
        const access = await query(`
            SELECT mu.role
            FROM model_users mu
            WHERE mu.model_id = ? AND mu.user_id = ? AND mu.is_active = TRUE
        `, [modelId, userId]);

        if (access.length === 0 && req.user.role !== 'admin') {
            return res.status(403).send('Access denied. You do not have permission to access this model.');
        }

        // Attach model info to request
        req.modelId = modelId;
        req.modelSlug = slug;
        req.modelRole = access.length > 0 ? access[0].role : 'admin';

        next();

    } catch (error) {
        console.error('Model access check error:', error);
        return res.status(500).send('Error checking model access');
    }
}

/**
 * Require admin role
 */
async function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).send('Access denied. Admin role required.');
    }
    next();
}

module.exports = {
    requireAuth,
    requireModelAccess,
    requireAdmin
};
