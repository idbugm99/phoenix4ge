/**
 * Email Verification Routes
 * Phase 1.1 of Authentication & Onboarding Implementation Plan
 */

const express = require('express');
const { body, query: validateQuery, validationResult } = require('express-validator');
const emailVerificationService = require('../services/EmailVerificationService');
const { authenticateToken } = require('../../middleware/auth');

const router = express.Router();

/**
 * POST /api/auth/send-verification
 * Send or resend verification email
 * Can be used by unauthenticated users (with email) or authenticated users
 */
router.post('/send-verification', [
    body('email')
        .optional()
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

        let email = req.body.email;

        // If no email provided, use authenticated user's email
        if (!email && req.user) {
            const db = require('../../config/database');
            const users = await db.query('SELECT email FROM users WHERE id = ?', [req.user.id]);
            if (users.length > 0) {
                email = users[0].email;
            }
        }

        if (!email) {
            return res.status(400).json({
                error: 'Email required',
                message: 'Please provide an email address'
            });
        }

        const result = await emailVerificationService.resendVerificationEmail(email);

        if (!result.success) {
            const statusCode = result.error === 'rate_limited' ? 429 : 400;
            return res.status(statusCode).json({
                error: result.error,
                message: result.message
            });
        }

        res.json({
            message: result.message,
            note: 'Please check your email for the verification link'
        });

    } catch (error) {
        console.error('Send verification error:', error);
        res.status(500).json({
            error: 'Server error',
            message: 'Unable to send verification email. Please try again.'
        });
    }
});

/**
 * POST /api/auth/verify-email
 * Verify email address with token
 */
router.post('/verify-email', [
    body('email')
        .isEmail()
        .normalizeEmail()
        .withMessage('Please provide a valid email address'),
    body('token')
        .notEmpty()
        .isLength({ min: 64, max: 64 })
        .withMessage('Invalid verification token')
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

        const result = await emailVerificationService.verifyEmail(email, token);

        if (!result.success) {
            return res.status(400).json({
                error: result.error,
                message: result.message
            });
        }

        res.json({
            message: result.message,
            userId: result.userId,
            verified: true
        });

    } catch (error) {
        console.error('Email verification error:', error);
        res.status(500).json({
            error: 'Server error',
            message: 'Unable to verify email. Please try again.'
        });
    }
});

/**
 * GET /api/auth/verification-status
 * Get verification status for authenticated user
 */
router.get('/verification-status', authenticateToken, async (req, res) => {
    try {
        const status = await emailVerificationService.getVerificationStatus(req.user.id);

        res.json(status);

    } catch (error) {
        console.error('Verification status error:', error);
        res.status(500).json({
            error: 'Server error',
            message: 'Unable to fetch verification status'
        });
    }
});

/**
 * GET /api/auth/check-email-verified
 * Quick check if user's email is verified (for middleware use)
 */
router.get('/check-email-verified', authenticateToken, async (req, res) => {
    try {
        const isVerified = await emailVerificationService.isEmailVerified(req.user.id);

        res.json({
            verified: isVerified,
            userId: req.user.id
        });

    } catch (error) {
        console.error('Check verified error:', error);
        res.status(500).json({
            error: 'Server error',
            message: 'Unable to check verification status'
        });
    }
});

module.exports = router;
