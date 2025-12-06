/**
 * Password Reset/Recovery Routes
 * Phase 1.2 of Authentication & Onboarding Implementation Plan
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const passwordResetService = require('../services/PasswordResetService');
const { authenticateToken } = require('../../middleware/auth');

const router = express.Router();

/**
 * POST /api/auth/forgot-password
 * Request password reset email
 */
router.post('/forgot-password', [
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Please provide a valid email address')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                error: 'Validation failed',
                message: 'Please check your input',
                details: errors.array()
            });
        }

        const { email } = req.body;
        const ipAddress = req.ip;
        const userAgent = req.get('user-agent');

        const result = await passwordResetService.sendPasswordResetEmail(email, ipAddress, userAgent);

        if (!result.success) {
            const statusCode = result.error === 'rate_limited' ? 429 : 400;
            return res.status(statusCode).json({
                error: result.error,
                message: result.message
            });
        }

        // Always return success to prevent email enumeration
        res.json({
            message: result.message,
            note: 'If the email exists, a reset link has been sent'
        });

    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({
            error: 'Server error',
            message: 'Unable to process password reset request. Please try again.'
        });
    }
});

/**
 * POST /api/auth/reset-password
 * Reset password with token
 */
router.post('/reset-password', [
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Please provide a valid email address'),
    body('token')
        .notEmpty()
        .isLength({ min: 64, max: 64 })
        .withMessage('Invalid reset token'),
    body('newPassword')
        .isLength({ min: 8 })
        .withMessage('Password must be at least 8 characters long')
        .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
        .withMessage('Password must contain at least one lowercase letter, one uppercase letter, and one number')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                error: 'Validation failed',
                message: 'Please check your input',
                details: errors.array()
            });
        }

        const { email, token, newPassword } = req.body;

        const result = await passwordResetService.resetPassword(email, token, newPassword);

        if (!result.success) {
            return res.status(400).json({
                error: result.error,
                message: result.message
            });
        }

        res.json({
            message: result.message,
            note: 'All sessions have been invalidated. Please log in again.'
        });

    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({
            error: 'Server error',
            message: 'Unable to reset password. Please try again.'
        });
    }
});

/**
 * POST /api/auth/verify-reset-token
 * Verify reset token validity (before showing password form)
 */
router.post('/verify-reset-token', [
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Please provide a valid email address'),
    body('token')
        .notEmpty()
        .isLength({ min: 64, max: 64 })
        .withMessage('Invalid reset token')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({
                error: 'Validation failed',
                message: 'Please check your input',
                details: errors.array()
            });
        }

        const { email, token } = req.body;

        const result = await passwordResetService.verifyResetToken(email, token);

        if (!result.success) {
            return res.status(400).json({
                error: result.error,
                message: result.message
            });
        }

        res.json({
            valid: true,
            email: result.email
        });

    } catch (error) {
        console.error('Verify reset token error:', error);
        res.status(500).json({
            error: 'Server error',
            message: 'Unable to verify reset token'
        });
    }
});

/**
 * GET /api/auth/password-reset-history
 * Get password reset history for authenticated user
 */
router.get('/password-reset-history', authenticateToken, async (req, res) => {
    try {
        const history = await passwordResetService.getResetHistory(req.user.id, 10);

        res.json({
            history: history.map(h => ({
                id: h.id,
                email: h.email,
                createdAt: h.created_at,
                expiresAt: h.expires_at,
                usedAt: h.used_at,
                ipAddress: h.ip_address,
                status: h.used_at ? 'used' : (new Date() > new Date(h.expires_at) ? 'expired' : 'active')
            }))
        });

    } catch (error) {
        console.error('Password reset history error:', error);
        res.status(500).json({
            error: 'Server error',
            message: 'Unable to fetch password reset history'
        });
    }
});

module.exports = router;
