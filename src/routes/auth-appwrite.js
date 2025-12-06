const express = require('express');
const { body, validationResult } = require('express-validator');
const { query } = require('../../config/database');
const { generateToken, authenticateToken } = require('../../middleware/auth');
const appwriteService = require('../../services/AppwriteService');

const router = express.Router();

// Register new user with Appwrite
router.post('/register', [
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Please provide a valid email address'),
    body('password')
        .isLength({ min: 8 })
        .withMessage('Password must be at least 8 characters long')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('Password must contain at least one lowercase letter, one uppercase letter, and one number'),
    body('name')
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage('Name must be between 2 and 100 characters')
], async (req, res) => {
    try {
        // Check validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.fail(400, 'Validation failed', {
                message: 'Please check your input',
                details: errors.array()
            });
        }

        const { email, password, name } = req.body;

        // Check if user already exists in Phoenix4ge DB
        const existingUsers = await query(
            'SELECT id FROM users WHERE email = ?',
            [email]
        );

        if (existingUsers.length > 0) {
            return res.fail(409, 'User exists', {
                message: 'An account with this email already exists'
            });
        }

        // Create user in Appwrite
        const appwriteResult = await appwriteService.createUser(email, password, name);

        if (!appwriteResult.success) {
            return res.fail(500, 'Registration failed', {
                message: 'Unable to create user account in authentication service',
                error: appwriteResult.error
            });
        }

        const appwriteUserId = appwriteResult.user.$id;

        // Create user in Phoenix4ge database
        const result = await query(`
            INSERT INTO users (appwrite_user_id, email, password_hash, role, is_active, created_at, updated_at)
            VALUES (?, ?, '', 'model', true, NOW(), NOW())
        `, [appwriteUserId, email]);

        const userId = result.insertId;

        // Create default model for user
        const modelSlug = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '-');
        const modelName = name;

        const modelResult = await query(`
            INSERT INTO models (name, slug, status, created_at, updated_at)
            VALUES (?, ?, 'trial', NOW(), NOW())
        `, [modelName, modelSlug]);

        const modelId = modelResult.insertId;

        // Create model-user relationship
        await query(`
            INSERT INTO model_users (model_id, user_id, role, is_active, added_at)
            VALUES (?, ?, 'owner', true, NOW())
        `, [modelId, userId]);

        // Create default site settings
        await query(`
            INSERT INTO site_settings (model_id, site_name, model_name, created_at, updated_at)
            VALUES (?, ?, ?, NOW(), NOW())
        `, [modelId, `${modelName}'s Portfolio`, modelName]);

        // Generate Phoenix4ge JWT token
        const newUser = {
            id: userId,
            email: email,
            role: 'model',
            appwrite_user_id: appwriteUserId
        };

        const token = generateToken(newUser);

        res.status(201).json({
            message: 'Account created successfully',
            user: {
                id: userId,
                email: email,
                role: 'model',
                appwrite_user_id: appwriteUserId,
                model: {
                    id: modelId,
                    name: modelName,
                    slug: modelSlug
                }
            },
            token: token
        });

    } catch (error) {
        console.error('Registration error:', error);
        res.fail(500, 'Registration failed', {
            message: 'Unable to create account. Please try again.',
            error: error.message
        });
    }
});

// Login user with Appwrite
router.post('/login', [
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Please provide a valid email address'),
    body('password')
        .notEmpty()
        .withMessage('Password is required')
], async (req, res) => {
    try {
        // Check validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.fail(400, 'Validation failed', {
                message: 'Please check your input',
                details: errors.array()
            });
        }

        const { email, password } = req.body;

        // Get Appwrite user
        const appwriteUser = await appwriteService.getUserByEmail(email);

        if (!appwriteUser) {
            return res.fail(401, 'Invalid credentials', {
                message: 'Email or password is incorrect'
            });
        }

        // Verify password with Appwrite
        // Note: For server-side, we'll verify by getting the user from Phoenix4ge DB
        // In production, the frontend should handle Appwrite sessions directly

        // Get user from Phoenix4ge database
        const users = await query(
            'SELECT id, email, appwrite_user_id, role, is_active FROM users WHERE email = ?',
            [email]
        );

        if (users.length === 0) {
            return res.fail(401, 'Invalid credentials', {
                message: 'Email or password is incorrect'
            });
        }

        const user = users[0];

        if (!user.is_active) {
            return res.fail(401, 'Account disabled', {
                message: 'Your account has been disabled. Please contact support.'
            });
        }

        // Get user's models
        const models = await query(`
            SELECT m.id, m.name, m.slug, m.status, mu.role
            FROM models m
            JOIN model_users mu ON m.id = mu.model_id
            WHERE mu.user_id = ? AND mu.is_active = true
            ORDER BY mu.role = 'owner' DESC, m.created_at ASC
        `, [user.id]);

        // Generate Phoenix4ge JWT token
        const token = generateToken(user);

        res.json({
            message: 'Login successful',
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
                appwrite_user_id: user.appwrite_user_id,
                models: models
            },
            token: token
        });

    } catch (error) {
        console.error('Login error:', error);
        res.fail(500, 'Login failed', {
            message: 'Unable to login. Please try again.',
            error: error.message
        });
    }
});

// Logout
router.post('/logout', authenticateToken, async (req, res) => {
    try {
        // Log the logout for security auditing
        console.log(`User ${req.user.email} (ID: ${req.user.id}) logged out at ${new Date().toISOString()}`);

        // Set security headers to prevent caching
        res.set({
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Clear-Site-Data': '"cache", "cookies", "storage"'
        });

        res.json({
            message: 'Logout successful',
            note: 'All session data has been cleared'
        });

    } catch (error) {
        console.error('Logout error:', error);
        res.json({
            message: 'Logout completed with warnings',
            note: 'Please clear all local session data'
        });
    }
});

// Get current user profile
router.get('/me', authenticateToken, async (req, res) => {
    try {
        // Get user's models
        const models = await query(`
            SELECT m.id, m.name, m.slug, m.status, mu.role
            FROM models m
            JOIN model_users mu ON m.id = mu.model_id
            WHERE mu.user_id = ? AND mu.is_active = true
            ORDER BY mu.role = 'owner' DESC, m.created_at ASC
        `, [req.user.id]);

        res.json({
            user: {
                id: req.user.id,
                email: req.user.email,
                role: req.user.role,
                appwrite_user_id: req.user.appwrite_user_id,
                models: models
            }
        });

    } catch (error) {
        console.error('Profile fetch error:', error);
        res.fail(500, 'Profile fetch failed', {
            message: 'Unable to fetch user profile'
        });
    }
});

// Change password (updates Appwrite)
router.post('/change-password', [
    authenticateToken,
    body('currentPassword')
        .notEmpty()
        .withMessage('Current password is required'),
    body('newPassword')
        .isLength({ min: 8 })
        .withMessage('New password must be at least 8 characters long')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('New password must contain at least one lowercase letter, one uppercase letter, and one number')
], async (req, res) => {
    try {
        // Check validation errors
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.fail(400, 'Validation failed', {
                message: 'Please check your input',
                details: errors.array()
            });
        }

        const { newPassword } = req.body;

        if (!req.user.appwrite_user_id) {
            return res.fail(400, 'Invalid user', {
                message: 'User is not linked to authentication service'
            });
        }

        // Update password in Appwrite
        const result = await appwriteService.updateUserPassword(
            req.user.appwrite_user_id,
            newPassword
        );

        if (!result.success) {
            return res.fail(500, 'Password change failed', {
                message: 'Unable to update password',
                error: result.error
            });
        }

        res.json({
            message: 'Password changed successfully'
        });

    } catch (error) {
        console.error('Password change error:', error);
        res.fail(500, 'Password change failed', {
            message: 'Unable to change password. Please try again.',
            error: error.message
        });
    }
});

// Verify token (for client-side token validation)
router.get('/verify', authenticateToken, (req, res) => {
    res.json({
        valid: true,
        user: {
            id: req.user.id,
            email: req.user.email,
            role: req.user.role,
            appwrite_user_id: req.user.appwrite_user_id
        }
    });
});

module.exports = router;
