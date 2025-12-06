/**
 * Refresh Token Routes
 * Phase 1.3 of Authentication & Onboarding Implementation Plan
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const refreshTokenService = require('../services/RefreshTokenService');
const { authenticateToken } = require('../../middleware/auth');

const router = express.Router();

/**
 * POST /api/auth/refresh
 * Use refresh token to get new access token
 */
router.post('/refresh', [
    body('refreshToken')
        .notEmpty()
        .isLength({ min: 64, max: 64 })
        .withMessage('Invalid refresh token')
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

        const { refreshToken } = req.body;
        const ipAddress = req.ip;
        const userAgent = req.get('user-agent');

        const result = await refreshTokenService.useRefreshToken(refreshToken, ipAddress, userAgent);

        if (!result.success) {
            return res.status(401).json({
                error: result.error,
                message: result.message
            });
        }

        res.json({
            accessToken: result.accessToken,
            refreshToken: result.refreshToken, // New token if rotation enabled
            expiresIn: result.expiresIn,
            tokenType: result.tokenType
        });

    } catch (error) {
        console.error('Refresh token error:', error);
        res.status(500).json({
            error: 'Server error',
            message: 'Unable to refresh token. Please try again.'
        });
    }
});

/**
 * POST /api/auth/revoke
 * Revoke a specific refresh token (logout)
 */
router.post('/revoke', [
    body('refreshToken')
        .notEmpty()
        .isLength({ min: 64, max: 64 })
        .withMessage('Invalid refresh token')
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

        const { refreshToken } = req.body;

        const revoked = await refreshTokenService.revokeRefreshToken(refreshToken);

        if (!revoked) {
            return res.status(404).json({
                error: 'Token not found',
                message: 'Refresh token not found or already revoked'
            });
        }

        res.json({
            message: 'Refresh token revoked successfully',
            note: 'You have been logged out'
        });

    } catch (error) {
        console.error('Revoke token error:', error);
        res.status(500).json({
            error: 'Server error',
            message: 'Unable to revoke token'
        });
    }
});

/**
 * POST /api/auth/revoke-all
 * Revoke all refresh tokens for authenticated user (logout all devices)
 */
router.post('/revoke-all', authenticateToken, async (req, res) => {
    try {
        const revokedCount = await refreshTokenService.revokeAllUserTokens(req.user.id);

        res.json({
            message: `Successfully logged out of ${revokedCount} device(s)`,
            revokedCount: revokedCount
        });

    } catch (error) {
        console.error('Revoke all tokens error:', error);
        res.status(500).json({
            error: 'Server error',
            message: 'Unable to revoke tokens'
        });
    }
});

/**
 * GET /api/auth/sessions
 * Get all active sessions for authenticated user
 */
router.get('/sessions', authenticateToken, async (req, res) => {
    try {
        const sessions = await refreshTokenService.getUserSessions(req.user.id);

        res.json({
            sessions: sessions,
            count: sessions.length
        });

    } catch (error) {
        console.error('Get sessions error:', error);
        res.status(500).json({
            error: 'Server error',
            message: 'Unable to fetch sessions'
        });
    }
});

/**
 * DELETE /api/auth/sessions/:sessionId
 * Revoke a specific session by ID
 */
router.delete('/sessions/:sessionId', authenticateToken, async (req, res) => {
    try {
        const sessionId = parseInt(req.params.sessionId);

        if (isNaN(sessionId)) {
            return res.status(400).json({
                error: 'Invalid session ID',
                message: 'Session ID must be a number'
            });
        }

        const revoked = await refreshTokenService.revokeSession(req.user.id, sessionId);

        if (!revoked) {
            return res.status(404).json({
                error: 'Session not found',
                message: 'Session not found or already revoked'
            });
        }

        res.json({
            message: 'Session revoked successfully'
        });

    } catch (error) {
        console.error('Revoke session error:', error);
        res.status(500).json({
            error: 'Server error',
            message: 'Unable to revoke session'
        });
    }
});

/**
 * GET /api/auth/token-stats
 * Get refresh token statistics (admin only)
 */
router.get('/token-stats', authenticateToken, async (req, res) => {
    try {
        // Only allow admin and sysadmin roles
        if (!['admin', 'sysadmin'].includes(req.user.role)) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'Admin access required'
            });
        }

        const stats = await refreshTokenService.getTokenStats();

        res.json({
            stats: stats
        });

    } catch (error) {
        console.error('Token stats error:', error);
        res.status(500).json({
            error: 'Server error',
            message: 'Unable to fetch token statistics'
        });
    }
});

module.exports = router;
