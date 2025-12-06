const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../../middleware/auth');
const onboardingService = require('../services/OnboardingService');

const router = express.Router();

/**
 * POST /api/auth/onboarding/initialize
 * Initialize onboarding for current user
 * Requires authentication
 */
router.post('/onboarding/initialize', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const progressId = await onboardingService.initializeOnboarding(userId);

        const progress = await onboardingService.getProgress(userId);

        res.json({
            message: 'Onboarding initialized successfully',
            progress: progress
        });

    } catch (error) {
        console.error('Initialize onboarding error:', error);
        res.fail(500, 'Failed to initialize', {
            message: 'Unable to initialize onboarding'
        });
    }
});

/**
 * GET /api/auth/onboarding/progress
 * Get current onboarding progress
 * Requires authentication
 */
router.get('/onboarding/progress', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const progress = await onboardingService.getProgress(userId);

        if (!progress) {
            return res.fail(404, 'Not found', {
                message: 'Onboarding not initialized'
            });
        }

        res.json({
            message: 'Onboarding progress retrieved',
            progress: {
                onboarding_completed: progress.onboarding_completed,
                completion_percentage: progress.completion_percentage,
                current_step: progress.current_step,
                completed_steps: JSON.parse(progress.completed_steps || '[]'),
                skipped_steps: JSON.parse(progress.skipped_steps || '[]'),
                started_at: progress.started_at,
                completed_at: progress.completed_at,
                days_since_signup: progress.days_since_signup,
                total_logins: progress.total_logins
            }
        });

    } catch (error) {
        console.error('Get onboarding progress error:', error);
        res.fail(500, 'Failed to get progress', {
            message: 'Unable to retrieve onboarding progress'
        });
    }
});

/**
 * GET /api/auth/onboarding/progress/detailed
 * Get detailed onboarding progress with step information
 * Requires authentication
 */
router.get('/onboarding/progress/detailed', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const detailedProgress = await onboardingService.getDetailedProgress(userId);

        if (!detailedProgress) {
            return res.fail(404, 'Not found', {
                message: 'Onboarding not initialized'
            });
        }

        res.json({
            message: 'Detailed onboarding progress retrieved',
            ...detailedProgress
        });

    } catch (error) {
        console.error('Get detailed onboarding progress error:', error);
        res.fail(500, 'Failed to get progress', {
            message: 'Unable to retrieve detailed onboarding progress'
        });
    }
});

/**
 * POST /api/auth/onboarding/steps/:stepKey/complete
 * Mark a step as completed
 * Requires authentication
 */
router.post('/onboarding/steps/:stepKey/complete', [
    authenticateToken,
    body('metadata').optional().isObject().withMessage('Metadata must be an object')
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.fail(400, 'Validation failed', {
                errors: errors.array()
            });
        }

        const userId = req.user.id;
        const { stepKey } = req.params;
        const { metadata } = req.body;

        const updatedProgress = await onboardingService.completeStep(userId, stepKey, metadata);

        res.json({
            message: `Step ${stepKey} completed successfully`,
            progress: {
                onboarding_completed: updatedProgress.onboarding_completed,
                completion_percentage: updatedProgress.completion_percentage,
                current_step: updatedProgress.current_step,
                completed_steps: JSON.parse(updatedProgress.completed_steps || '[]')
            }
        });

    } catch (error) {
        console.error('Complete onboarding step error:', error);
        res.fail(500, 'Failed to complete step', {
            message: error.message || 'Unable to complete onboarding step'
        });
    }
});

/**
 * POST /api/auth/onboarding/steps/:stepKey/skip
 * Skip a step (optional steps only)
 * Requires authentication
 */
router.post('/onboarding/steps/:stepKey/skip', [
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

        const userId = req.user.id;
        const { stepKey } = req.params;
        const { reason } = req.body;

        const updatedProgress = await onboardingService.skipStep(userId, stepKey, reason);

        res.json({
            message: `Step ${stepKey} skipped successfully`,
            progress: {
                completion_percentage: updatedProgress.completion_percentage,
                current_step: updatedProgress.current_step,
                skipped_steps: JSON.parse(updatedProgress.skipped_steps || '[]')
            }
        });

    } catch (error) {
        console.error('Skip onboarding step error:', error);

        // Check if error is about required step
        if (error.message.includes('Cannot skip required step')) {
            return res.fail(400, 'Cannot skip', {
                message: 'This step is required and cannot be skipped'
            });
        }

        res.fail(500, 'Failed to skip step', {
            message: error.message || 'Unable to skip onboarding step'
        });
    }
});

/**
 * POST /api/auth/onboarding/engagement/update
 * Update engagement metrics (called on login)
 * Requires authentication
 */
router.post('/onboarding/engagement/update', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        await onboardingService.updateEngagementMetrics(userId);

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
 * GET /api/auth/onboarding/analytics
 * Get onboarding analytics (admin only)
 * Requires authentication and admin role
 */
router.get('/onboarding/analytics', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin') {
            return res.fail(403, 'Forbidden', {
                message: 'Admin access required'
            });
        }

        const analytics = await onboardingService.getOnboardingAnalytics();

        res.json({
            message: 'Onboarding analytics retrieved successfully',
            analytics: analytics
        });

    } catch (error) {
        console.error('Get onboarding analytics error:', error);
        res.fail(500, 'Failed to get analytics', {
            message: 'Unable to retrieve onboarding analytics'
        });
    }
});

/**
 * GET /api/auth/onboarding/followup
 * Get users needing onboarding follow-up (admin only)
 * Requires authentication and admin role
 */
router.get('/onboarding/followup', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin') {
            return res.fail(403, 'Forbidden', {
                message: 'Admin access required'
            });
        }

        const inactiveDays = parseInt(req.query.inactiveDays) || 3;

        const users = await onboardingService.getUsersNeedingFollowup(inactiveDays);

        res.json({
            message: 'Users needing follow-up retrieved successfully',
            users: users,
            count: users.length,
            criteria: {
                inactiveDays: inactiveDays
            }
        });

    } catch (error) {
        console.error('Get users needing follow-up error:', error);
        res.fail(500, 'Failed to get users', {
            message: 'Unable to retrieve users needing follow-up'
        });
    }
});

/**
 * POST /api/auth/onboarding/:userId/mark-abandoned
 * Mark user's onboarding as abandoned (admin only)
 * Requires authentication and admin role
 */
router.post('/onboarding/:userId/mark-abandoned', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        if (req.user.role !== 'admin') {
            return res.fail(403, 'Forbidden', {
                message: 'Admin access required'
            });
        }

        const userId = parseInt(req.params.userId);

        await onboardingService.markAbandoned(userId);

        res.json({
            message: 'Onboarding marked as abandoned',
            userId: userId
        });

    } catch (error) {
        console.error('Mark onboarding abandoned error:', error);
        res.fail(500, 'Failed to mark abandoned', {
            message: 'Unable to mark onboarding as abandoned'
        });
    }
});

/**
 * GET /api/auth/onboarding/steps
 * Get all available onboarding steps (public configuration)
 */
router.get('/onboarding/steps', async (req, res) => {
    try {
        const { query: dbQuery } = require('../../config/database');

        const steps = await dbQuery(`
            SELECT step_key, step_name, step_description, step_order,
                   required, help_text, help_url
            FROM onboarding_steps
            WHERE enabled = TRUE
            ORDER BY step_order ASC
        `);

        res.json({
            message: 'Onboarding steps retrieved successfully',
            steps: steps,
            count: steps.length
        });

    } catch (error) {
        console.error('Get onboarding steps error:', error);
        res.fail(500, 'Failed to get steps', {
            message: 'Unable to retrieve onboarding steps'
        });
    }
});

module.exports = router;
