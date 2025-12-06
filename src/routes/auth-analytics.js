const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../../middleware/auth');
const analyticsService = require('../services/AnalyticsService');

const router = express.Router();

/**
 * POST /api/auth/analytics/session/start
 * Start a new analytics session
 * Requires authentication
 */
router.post('/analytics/session/start', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const refreshTokenId = req.body.refreshTokenId || null;
        const ipAddress = req.ip;
        const userAgent = req.get('user-agent');

        const sessionId = await analyticsService.createSession(
            userId,
            refreshTokenId,
            ipAddress,
            userAgent
        );

        res.json({
            message: 'Session started successfully',
            sessionId: sessionId
        });

    } catch (error) {
        console.error('Start session error:', error);
        res.fail(500, 'Failed to start session', {
            message: 'Unable to create analytics session'
        });
    }
});

/**
 * POST /api/auth/analytics/session/:sessionId/end
 * End an analytics session
 * Requires authentication
 */
router.post('/analytics/session/:sessionId/end', [
    authenticateToken,
    body('reason').optional().isString().withMessage('Reason must be a string')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.fail(400, 'Validation failed', {
                errors: errors.array()
            });
        }

        const sessionId = parseInt(req.params.sessionId);
        const reason = req.body.reason || 'logout';

        await analyticsService.endSession(sessionId, reason);

        res.json({
            message: 'Session ended successfully',
            sessionId: sessionId
        });

    } catch (error) {
        console.error('End session error:', error);
        res.fail(500, 'Failed to end session', {
            message: 'Unable to end analytics session'
        });
    }
});

/**
 * POST /api/auth/analytics/session/:sessionId/heartbeat
 * Update session activity (heartbeat)
 * Requires authentication
 */
router.post('/analytics/session/:sessionId/heartbeat', authenticateToken, async (req, res) => {
    try {
        const sessionId = parseInt(req.params.sessionId);

        await analyticsService.updateSessionActivity(sessionId);

        res.json({
            message: 'Session activity updated',
            sessionId: sessionId
        });

    } catch (error) {
        console.error('Update session activity error:', error);
        res.fail(500, 'Failed to update', {
            message: 'Unable to update session activity'
        });
    }
});

/**
 * POST /api/auth/analytics/activity/log
 * Log user activity
 * Requires authentication
 */
router.post('/analytics/activity/log', [
    authenticateToken,
    body('activityType').notEmpty().withMessage('Activity type is required'),
    body('activityCategory').optional().isString(),
    body('endpoint').optional().isString(),
    body('httpMethod').optional().isString(),
    body('metadata').optional().isObject(),
    body('responseTimeMs').optional().isInt(),
    body('statusCode').optional().isInt()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.fail(400, 'Validation failed', {
                errors: errors.array()
            });
        }

        const userId = req.user.id;
        const {
            sessionId,
            activityType,
            activityCategory,
            endpoint,
            httpMethod,
            metadata,
            responseTimeMs,
            statusCode
        } = req.body;

        const ipAddress = req.ip;
        const userAgent = req.get('user-agent');

        const activityId = await analyticsService.logActivity(
            userId,
            sessionId || null,
            activityType,
            activityCategory || null,
            endpoint || null,
            httpMethod || null,
            ipAddress,
            userAgent,
            metadata,
            responseTimeMs,
            statusCode
        );

        res.json({
            message: 'Activity logged successfully',
            activityId: activityId
        });

    } catch (error) {
        console.error('Log activity error:', error);
        res.fail(500, 'Failed to log activity', {
            message: 'Unable to log activity'
        });
    }
});

/**
 * POST /api/auth/analytics/events/track
 * Track analytics event
 * Requires authentication
 */
router.post('/analytics/events/track', [
    authenticateToken,
    body('eventName').notEmpty().withMessage('Event name is required'),
    body('eventCategory').notEmpty().withMessage('Event category is required'),
    body('properties').optional().isObject(),
    body('utm').optional().isObject()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.fail(400, 'Validation failed', {
                errors: errors.array()
            });
        }

        const userId = req.user.id;
        const {
            eventName,
            eventCategory,
            sessionId,
            properties,
            utm
        } = req.body;

        const ipAddress = req.ip;
        const userAgent = req.get('user-agent');
        const referrer = req.get('referrer') || req.get('referer') || null;

        const eventId = await analyticsService.trackEvent(
            eventName,
            eventCategory,
            userId,
            sessionId || null,
            properties,
            ipAddress,
            userAgent,
            referrer,
            utm
        );

        res.json({
            message: 'Event tracked successfully',
            eventId: eventId
        });

    } catch (error) {
        console.error('Track event error:', error);
        res.fail(500, 'Failed to track event', {
            message: 'Unable to track analytics event'
        });
    }
});

/**
 * POST /api/auth/analytics/funnel/track
 * Track funnel event
 * Requires authentication
 */
router.post('/analytics/funnel/track', [
    authenticateToken,
    body('funnelName').notEmpty().withMessage('Funnel name is required'),
    body('funnelStep').notEmpty().withMessage('Funnel step is required'),
    body('stepOrder').isInt().withMessage('Step order must be an integer'),
    body('eventType').notEmpty().withMessage('Event type is required'),
    body('metadata').optional().isObject()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.fail(400, 'Validation failed', {
                errors: errors.array()
            });
        }

        const userId = req.user.id;
        const {
            funnelName,
            funnelStep,
            stepOrder,
            eventType,
            sessionId,
            metadata
        } = req.body;

        const ipAddress = req.ip;

        const funnelEventId = await analyticsService.trackFunnelEvent(
            funnelName,
            funnelStep,
            stepOrder,
            eventType,
            userId,
            sessionId || null,
            ipAddress,
            metadata
        );

        res.json({
            message: 'Funnel event tracked successfully',
            funnelEventId: funnelEventId
        });

    } catch (error) {
        console.error('Track funnel event error:', error);
        res.fail(500, 'Failed to track funnel', {
            message: 'Unable to track funnel event'
        });
    }
});

/**
 * POST /api/auth/analytics/engagement/update
 * Update daily engagement metrics for user
 * Requires authentication
 */
router.post('/analytics/engagement/update', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        await analyticsService.updateDailyEngagementMetrics(userId);

        res.json({
            message: 'Engagement metrics updated successfully'
        });

    } catch (error) {
        console.error('Update engagement metrics error:', error);
        res.fail(500, 'Failed to update', {
            message: 'Unable to update engagement metrics'
        });
    }
});

/**
 * GET /api/auth/analytics/my-engagement
 * Get current user's engagement analytics
 * Requires authentication
 */
router.get('/analytics/my-engagement', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const days = parseInt(req.query.days) || 30;

        const analytics = await analyticsService.getUserEngagementAnalytics(userId, days);

        res.json({
            message: 'Engagement analytics retrieved successfully',
            analytics: analytics,
            period: {
                days: days
            }
        });

    } catch (error) {
        console.error('Get engagement analytics error:', error);
        res.fail(500, 'Failed to get analytics', {
            message: 'Unable to retrieve engagement analytics'
        });
    }
});

/**
 * GET /api/auth/analytics/platform
 * Get platform-wide analytics (admin only)
 * Requires authentication and admin role
 */
router.get('/analytics/platform', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin') {
            return res.fail(403, 'Forbidden', {
                message: 'Admin access required'
            });
        }

        const days = parseInt(req.query.days) || 30;

        const analytics = await analyticsService.getPlatformAnalytics(days);

        res.json({
            message: 'Platform analytics retrieved successfully',
            analytics: analytics,
            period: {
                days: days
            }
        });

    } catch (error) {
        console.error('Get platform analytics error:', error);
        res.fail(500, 'Failed to get analytics', {
            message: 'Unable to retrieve platform analytics'
        });
    }
});

/**
 * GET /api/auth/analytics/user/:userId/engagement
 * Get engagement analytics for specific user (admin only)
 * Requires authentication and admin role
 */
router.get('/analytics/user/:userId/engagement', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin') {
            return res.fail(403, 'Forbidden', {
                message: 'Admin access required'
            });
        }

        const userId = parseInt(req.params.userId);
        const days = parseInt(req.query.days) || 30;

        const analytics = await analyticsService.getUserEngagementAnalytics(userId, days);

        res.json({
            message: 'User engagement analytics retrieved successfully',
            userId: userId,
            analytics: analytics,
            period: {
                days: days
            }
        });

    } catch (error) {
        console.error('Get user engagement analytics error:', error);
        res.fail(500, 'Failed to get analytics', {
            message: 'Unable to retrieve user engagement analytics'
        });
    }
});

module.exports = router;
