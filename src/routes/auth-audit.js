const express = require('express');
const { authenticateToken } = require('../../middleware/auth');
const authAuditService = require('../services/AuthAuditService');
const loginAttemptService = require('../services/LoginAttemptService');

const router = express.Router();

/**
 * GET /api/auth/audit/my-activity
 * Get authenticated user's audit log
 * Requires authentication
 */
router.get('/audit/my-activity', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;

        const auditLog = await authAuditService.getUserAuditLog(userId, limit, offset);

        res.json({
            message: 'Audit log retrieved successfully',
            auditLog: auditLog,
            count: auditLog.length,
            limit: limit,
            offset: offset
        });

    } catch (error) {
        console.error('Get audit log error:', error);
        res.fail(500, 'Failed to retrieve audit log', {
            message: 'Unable to retrieve audit log'
        });
    }
});

/**
 * GET /api/auth/audit/my-login-history
 * Get authenticated user's login attempt history
 * Requires authentication
 */
router.get('/audit/my-login-history', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 20;

        const loginHistory = await loginAttemptService.getLoginHistory(userId, limit);

        res.json({
            message: 'Login history retrieved successfully',
            loginHistory: loginHistory,
            count: loginHistory.length
        });

    } catch (error) {
        console.error('Get login history error:', error);
        res.fail(500, 'Failed to retrieve login history', {
            message: 'Unable to retrieve login history'
        });
    }
});

/**
 * GET /api/auth/audit/my-summary
 * Get authenticated user's daily audit summary
 * Requires authentication
 */
router.get('/audit/my-summary', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const days = parseInt(req.query.days) || 30;

        const summary = await authAuditService.getUserDailySummary(userId, days);

        res.json({
            message: 'Audit summary retrieved successfully',
            summary: summary,
            days: days
        });

    } catch (error) {
        console.error('Get audit summary error:', error);
        res.fail(500, 'Failed to retrieve audit summary', {
            message: 'Unable to retrieve audit summary'
        });
    }
});

/**
 * GET /api/auth/audit/my-alerts
 * Get authenticated user's suspicious activity alerts
 * Requires authentication
 */
router.get('/audit/my-alerts', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const status = req.query.status || null; // new, investigating, resolved, false_positive

        const alerts = await authAuditService.getSuspiciousActivityAlerts(userId, status);

        res.json({
            message: 'Suspicious activity alerts retrieved successfully',
            alerts: alerts,
            count: alerts.length
        });

    } catch (error) {
        console.error('Get suspicious alerts error:', error);
        res.fail(500, 'Failed to retrieve alerts', {
            message: 'Unable to retrieve suspicious activity alerts'
        });
    }
});

/**
 * GET /api/auth/audit/stats
 * Get audit statistics (admin only)
 * Requires authentication + admin role
 */
router.get('/audit/stats', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
            return res.fail(403, 'Access denied', {
                message: 'Admin access required'
            });
        }

        const auditStats = await authAuditService.getAuditStats();
        const lockoutStats = await loginAttemptService.getLockoutStats();

        res.json({
            message: 'Audit statistics retrieved successfully',
            audit: auditStats,
            lockout: lockoutStats
        });

    } catch (error) {
        console.error('Get audit stats error:', error);
        res.fail(500, 'Failed to retrieve statistics', {
            message: 'Unable to retrieve audit statistics'
        });
    }
});

/**
 * GET /api/auth/audit/alerts
 * Get all suspicious activity alerts (admin only)
 * Requires authentication + admin role
 */
router.get('/audit/alerts', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
            return res.fail(403, 'Access denied', {
                message: 'Admin access required'
            });
        }

        const status = req.query.status || null;
        const alerts = await authAuditService.getSuspiciousActivityAlerts(null, status);

        res.json({
            message: 'All suspicious activity alerts retrieved successfully',
            alerts: alerts,
            count: alerts.length
        });

    } catch (error) {
        console.error('Get all alerts error:', error);
        res.fail(500, 'Failed to retrieve alerts', {
            message: 'Unable to retrieve alerts'
        });
    }
});

/**
 * POST /api/auth/audit/unlock-account
 * Manually unlock a locked account (admin only)
 * Requires authentication + admin role
 */
router.post('/audit/unlock-account', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
            return res.fail(403, 'Access denied', {
                message: 'Admin access required'
            });
        }

        const { userId } = req.body;

        if (!userId) {
            return res.fail(400, 'Validation failed', {
                message: 'User ID is required'
            });
        }

        await loginAttemptService.unlockAccount(userId);

        // Log admin action
        await authAuditService.logEvent({
            eventType: 'account_unlocked',
            eventCategory: 'security',
            userId: userId,
            success: true,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
            metadata: {
                adminId: req.user.id,
                adminEmail: req.user.email
            }
        });

        res.json({
            message: 'Account unlocked successfully',
            userId: userId
        });

    } catch (error) {
        console.error('Unlock account error:', error);
        res.fail(500, 'Failed to unlock account', {
            message: 'Unable to unlock account'
        });
    }
});

/**
 * GET /api/auth/audit/user/:userId
 * Get audit log for specific user (admin only)
 * Requires authentication + admin role
 */
router.get('/audit/user/:userId', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
            return res.fail(403, 'Access denied', {
                message: 'Admin access required'
            });
        }

        const userId = parseInt(req.params.userId);
        const limit = parseInt(req.query.limit) || 50;
        const offset = parseInt(req.query.offset) || 0;

        const auditLog = await authAuditService.getUserAuditLog(userId, limit, offset);

        res.json({
            message: 'User audit log retrieved successfully',
            userId: userId,
            auditLog: auditLog,
            count: auditLog.length
        });

    } catch (error) {
        console.error('Get user audit log error:', error);
        res.fail(500, 'Failed to retrieve user audit log', {
            message: 'Unable to retrieve audit log'
        });
    }
});

/**
 * GET /api/auth/audit/login-history/:email
 * Get login history for specific email (admin only)
 * Requires authentication + admin role
 */
router.get('/audit/login-history/:email', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
            return res.fail(403, 'Access denied', {
                message: 'Admin access required'
            });
        }

        const email = req.params.email;
        const limit = parseInt(req.query.limit) || 50;

        const loginHistory = await loginAttemptService.getLoginHistory(email, limit);

        res.json({
            message: 'Login history retrieved successfully',
            email: email,
            loginHistory: loginHistory,
            count: loginHistory.length
        });

    } catch (error) {
        console.error('Get login history error:', error);
        res.fail(500, 'Failed to retrieve login history', {
            message: 'Unable to retrieve login history'
        });
    }
});

module.exports = router;
