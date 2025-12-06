const jwt = require('jsonwebtoken');
const db = require('../config/database');

// Generate JWT token
function generateToken(user) {
    return jwt.sign(
        {
            id: user.id,
            email: user.email,
            role: user.role
        },
        process.env.JWT_SECRET,
        {
            expiresIn: process.env.JWT_EXPIRES_IN || '7d'
        }
    );
}

// Verify JWT token middleware
async function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
        return res.status(401).json({
            error: 'Access denied',
            message: 'No token provided'
        });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Get fresh user data from database
        const [users] = await db.execute(
            'SELECT id, email, role, is_active, appwrite_user_id FROM users WHERE id = ?',
            [decoded.id]
        );

        if (users.length === 0) {
            return res.status(401).json({
                error: 'Invalid token',
                message: 'User not found'
            });
        }

        const user = users[0];

        if (!user.is_active) {
            return res.status(401).json({
                error: 'Account disabled',
                message: 'Your account has been disabled'
            });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error('Token verification error:', error);
        
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                error: 'Token expired',
                message: 'Please login again'
            });
        }
        
        return res.status(403).json({
            error: 'Invalid token',
            message: 'Token verification failed'
        });
    }
}

// Role-based authorization middleware
function requireRole(roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                error: 'Authentication required',
                message: 'Please login first'
            });
        }

        const userRoles = Array.isArray(roles) ? roles : [roles];
        
        if (!userRoles.includes(req.user.role)) {
            return res.status(403).json({
                error: 'Insufficient permissions',
                message: 'You do not have permission to access this resource'
            });
        }

        next();
    };
}

// Model ownership verification middleware
async function requireModelAccess(req, res, next) {
    try {
        const modelSlug = req.params.slug;
        const userId = req.user.id;

        // Check if user has access to this model
        const [access] = await db.execute(`
            SELECT mu.role, m.id, m.name, m.slug
            FROM model_users mu
            JOIN models m ON mu.model_id = m.id
            WHERE m.slug = ? AND mu.user_id = ? AND mu.is_active = true
        `, [modelSlug, userId]);

        if (access.length === 0) {
            return res.status(403).json({
                error: 'Access denied',
                message: 'You do not have access to this model'
            });
        }

        req.model = access[0];
        req.modelAccess = access[0].role; // owner, admin, editor, viewer
        next();
    } catch (error) {
        console.error('Model access verification error:', error);
        return res.status(500).json({
            error: 'Internal server error',
            message: 'Failed to verify model access'
        });
    }
}

// Check if user can edit model content
function requireEditAccess(req, res, next) {
    const editRoles = ['owner', 'admin', 'editor'];
    
    if (!editRoles.includes(req.modelAccess)) {
        return res.status(403).json({
            error: 'Insufficient permissions',
            message: 'You need edit access to modify this content'
        });
    }
    
    next();
}

// Check if user can manage model (delete, add users, etc.)
function requireAdminAccess(req, res, next) {
    const adminRoles = ['owner', 'admin'];
    
    if (!adminRoles.includes(req.modelAccess)) {
        return res.status(403).json({
            error: 'Insufficient permissions',
            message: 'You need admin access to perform this action'
        });
    }
    
    next();
}

// Optional authentication (for public/private content)
async function optionalAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        req.user = null;
        return next();
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const [users] = await db.execute(
            'SELECT id, email, role, is_active, appwrite_user_id FROM users WHERE id = ?',
            [decoded.id]
        );

        if (users.length > 0 && users[0].is_active) {
            req.user = users[0];
        } else {
            req.user = null;
        }
    } catch (error) {
        req.user = null;
    }

    next();
}

module.exports = {
    generateToken,
    authenticateToken,
    requireRole,
    requireModelAccess,
    requireEditAccess,
    requireAdminAccess,
    optionalAuth
};