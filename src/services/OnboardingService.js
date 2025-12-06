const { query } = require('../../config/database');

/**
 * OnboardingService - User onboarding progress tracking
 *
 * Features:
 * - Initialize onboarding for new users
 * - Track step completion and progress
 * - Calculate completion percentage based on step weights
 * - Handle required vs optional steps
 * - Track engagement metrics (logins, days since signup)
 * - Log onboarding events for analytics
 */
class OnboardingService {
    /**
     * Initialize onboarding progress for a new user
     * @param {number} userId - User ID
     * @returns {Promise<number>} Onboarding progress ID
     */
    async initializeOnboarding(userId) {
        // Check if already initialized
        const existing = await query(`
            SELECT id FROM onboarding_progress WHERE user_id = ?
        `, [userId]);

        if (existing.length > 0) {
            console.log(`⚠️  Onboarding already initialized for user ${userId}`);
            return existing[0].id;
        }

        // Get first step
        const steps = await query(`
            SELECT step_key FROM onboarding_steps
            WHERE enabled = TRUE
            ORDER BY step_order ASC
            LIMIT 1
        `);

        const firstStep = steps.length > 0 ? steps[0].step_key : null;

        // Initialize progress
        const result = await query(`
            INSERT INTO onboarding_progress (
                user_id,
                current_step,
                completed_steps,
                skipped_steps,
                onboarding_completed,
                completion_percentage,
                started_at,
                created_at
            )
            VALUES (?, ?, '[]', '[]', FALSE, 0, NOW(), NOW())
        `, [userId, firstStep]);

        // Log initialization event
        await this.trackEvent(userId, 'onboarding_started', firstStep);

        console.log(`✅ Initialized onboarding for user ${userId}`);
        return result.insertId;
    }

    /**
     * Mark a step as completed
     * @param {number} userId - User ID
     * @param {string} stepKey - Step key (email_verification, profile_setup, etc)
     * @param {Object} metadata - Additional metadata
     * @returns {Promise<Object>} Updated progress
     */
    async completeStep(userId, stepKey, metadata = null) {
        // Get current progress
        const progress = await this.getProgress(userId);

        if (!progress) {
            // Initialize if doesn't exist
            await this.initializeOnboarding(userId);
            return await this.completeStep(userId, stepKey, metadata);
        }

        // Check if already completed
        const completedSteps = JSON.parse(progress.completed_steps || '[]');
        if (completedSteps.includes(stepKey)) {
            console.log(`⚠️  Step ${stepKey} already completed for user ${userId}`);
            return progress;
        }

        // Add to completed steps
        completedSteps.push(stepKey);

        // Update timestamp for specific step
        const timestampMap = {
            'email_verification': 'email_verified_at',
            'profile_setup': 'profile_completed_at',
            'first_content': 'first_content_uploaded_at',
            'payment_setup': 'payment_method_added_at',
            'mfa_setup': 'mfa_enabled_at'
        };

        const timestampColumn = timestampMap[stepKey];
        let timestampUpdate = '';
        if (timestampColumn) {
            timestampUpdate = `, ${timestampColumn} = NOW()`;
        }

        // Get next step
        const nextStep = await this.getNextStep(userId, completedSteps);

        // Calculate new completion percentage
        const completionPercentage = await this.calculateCompletionPercentage(completedSteps);

        // Check if onboarding is complete
        const isComplete = await this.isOnboardingComplete(completedSteps);

        // Update progress
        await query(`
            UPDATE onboarding_progress
            SET completed_steps = ?,
                current_step = ?,
                completion_percentage = ?,
                onboarding_completed = ?,
                completed_at = ${isComplete ? 'NOW()' : 'completed_at'},
                updated_at = NOW()
                ${timestampUpdate}
            WHERE user_id = ?
        `, [
            JSON.stringify(completedSteps),
            nextStep,
            completionPercentage,
            isComplete,
            userId
        ]);

        // Update user table if complete
        if (isComplete) {
            await query(`
                UPDATE users
                SET onboarding_completed = TRUE,
                    onboarding_completed_at = NOW()
                WHERE id = ?
            `, [userId]);
        }

        // Log completion event
        await this.trackEvent(userId, 'step_completed', stepKey, metadata);

        console.log(`✅ Completed step ${stepKey} for user ${userId} (${completionPercentage}% complete)`);

        return await this.getProgress(userId);
    }

    /**
     * Skip a step (for optional steps)
     * @param {number} userId - User ID
     * @param {string} stepKey - Step key
     * @param {string} reason - Reason for skipping
     * @returns {Promise<Object>} Updated progress
     */
    async skipStep(userId, stepKey, reason = null) {
        const progress = await this.getProgress(userId);

        if (!progress) {
            throw new Error('Onboarding not initialized');
        }

        // Check if step is required
        const steps = await query(`
            SELECT required FROM onboarding_steps WHERE step_key = ?
        `, [stepKey]);

        if (steps.length > 0 && steps[0].required) {
            throw new Error('Cannot skip required step');
        }

        // Add to skipped steps
        const skippedSteps = JSON.parse(progress.skipped_steps || '[]');
        if (!skippedSteps.includes(stepKey)) {
            skippedSteps.push(stepKey);
        }

        // Get next step
        const completedSteps = JSON.parse(progress.completed_steps || '[]');
        const nextStep = await this.getNextStep(userId, completedSteps, skippedSteps);

        // Update progress
        await query(`
            UPDATE onboarding_progress
            SET skipped_steps = ?,
                current_step = ?,
                updated_at = NOW()
            WHERE user_id = ?
        `, [JSON.stringify(skippedSteps), nextStep, userId]);

        // Log skip event
        await this.trackEvent(userId, 'step_skipped', stepKey, { reason });

        console.log(`⏭️  Skipped step ${stepKey} for user ${userId}`);

        return await this.getProgress(userId);
    }

    /**
     * Get current onboarding progress for user
     * @param {number} userId - User ID
     * @returns {Promise<Object|null>} Progress object or null
     */
    async getProgress(userId) {
        const results = await query(`
            SELECT * FROM onboarding_progress WHERE user_id = ?
        `, [userId]);

        return results.length > 0 ? results[0] : null;
    }

    /**
     * Get detailed progress with step information
     * @param {number} userId - User ID
     * @returns {Promise<Object>} Detailed progress
     */
    async getDetailedProgress(userId) {
        const progress = await this.getProgress(userId);

        if (!progress) {
            return null;
        }

        // Get all enabled steps
        const steps = await query(`
            SELECT step_key, step_name, step_description, step_order,
                   required, weight, help_text, help_url
            FROM onboarding_steps
            WHERE enabled = TRUE
            ORDER BY step_order ASC
        `);

        const completedSteps = JSON.parse(progress.completed_steps || '[]');
        const skippedSteps = JSON.parse(progress.skipped_steps || '[]');

        // Enrich steps with status
        const enrichedSteps = steps.map(step => ({
            ...step,
            status: completedSteps.includes(step.step_key) ? 'completed' :
                    skippedSteps.includes(step.step_key) ? 'skipped' :
                    step.step_key === progress.current_step ? 'current' : 'pending'
        }));

        return {
            progress: {
                onboarding_completed: progress.onboarding_completed,
                completion_percentage: progress.completion_percentage,
                current_step: progress.current_step,
                started_at: progress.started_at,
                completed_at: progress.completed_at,
                days_since_signup: progress.days_since_signup,
                total_logins: progress.total_logins
            },
            steps: enrichedSteps
        };
    }

    /**
     * Calculate completion percentage based on step weights
     * @param {Array<string>} completedSteps - Array of completed step keys
     * @returns {Promise<number>} Completion percentage (0-100)
     */
    async calculateCompletionPercentage(completedSteps) {
        // Get all required steps with weights
        const steps = await query(`
            SELECT step_key, weight, required
            FROM onboarding_steps
            WHERE enabled = TRUE
        `);

        // Calculate total weight of required steps
        const totalRequiredWeight = steps
            .filter(s => s.required)
            .reduce((sum, s) => sum + s.weight, 0);

        // Calculate weight of completed required steps
        const completedRequiredWeight = steps
            .filter(s => s.required && completedSteps.includes(s.step_key))
            .reduce((sum, s) => sum + s.weight, 0);

        // Calculate weight of completed optional steps
        const completedOptionalWeight = steps
            .filter(s => !s.required && completedSteps.includes(s.step_key))
            .reduce((sum, s) => sum + s.weight, 0);

        // Base percentage from required steps
        let percentage = totalRequiredWeight > 0
            ? Math.round((completedRequiredWeight / totalRequiredWeight) * 100)
            : 0;

        // Add bonus for optional steps (capped at 100%)
        const optionalBonus = Math.min(completedOptionalWeight, 100 - percentage);
        percentage = Math.min(percentage + optionalBonus, 100);

        return percentage;
    }

    /**
     * Check if onboarding is complete (all required steps done)
     * @param {Array<string>} completedSteps - Array of completed step keys
     * @returns {Promise<boolean>} True if complete
     */
    async isOnboardingComplete(completedSteps) {
        const requiredSteps = await query(`
            SELECT step_key FROM onboarding_steps
            WHERE enabled = TRUE AND required = TRUE
        `);

        const requiredKeys = requiredSteps.map(s => s.step_key);

        // Check if all required steps are completed
        return requiredKeys.every(key => completedSteps.includes(key));
    }

    /**
     * Get next step in onboarding flow
     * @param {number} userId - User ID
     * @param {Array<string>} completedSteps - Completed step keys
     * @param {Array<string>} skippedSteps - Skipped step keys
     * @returns {Promise<string|null>} Next step key or null if complete
     */
    async getNextStep(userId, completedSteps, skippedSteps = []) {
        // Get all enabled steps in order
        const steps = await query(`
            SELECT step_key FROM onboarding_steps
            WHERE enabled = TRUE
            ORDER BY step_order ASC
        `);

        // Find first step that's not completed or skipped
        for (const step of steps) {
            if (!completedSteps.includes(step.step_key) &&
                !skippedSteps.includes(step.step_key)) {
                return step.step_key;
            }
        }

        // All steps completed or skipped
        return null;
    }

    /**
     * Track onboarding event for analytics
     * @param {number} userId - User ID
     * @param {string} eventType - Event type (step_started, step_completed, step_skipped, etc)
     * @param {string} stepKey - Step key
     * @param {Object} metadata - Additional metadata
     * @returns {Promise<number>} Event ID
     */
    async trackEvent(userId, eventType, stepKey = null, metadata = null) {
        const result = await query(`
            INSERT INTO onboarding_events (
                user_id,
                event_type,
                step_key,
                metadata,
                created_at
            )
            VALUES (?, ?, ?, ?, NOW())
        `, [
            userId,
            eventType,
            stepKey,
            metadata ? JSON.stringify(metadata) : null
        ]);

        return result.insertId;
    }

    /**
     * Update engagement metrics (logins, days since signup)
     * @param {number} userId - User ID
     * @returns {Promise<void>}
     */
    async updateEngagementMetrics(userId) {
        // Get user signup date
        const users = await query(`
            SELECT created_at FROM users WHERE id = ?
        `, [userId]);

        if (users.length === 0) {
            return;
        }

        const signupDate = new Date(users[0].created_at);
        const now = new Date();
        const daysSinceSignup = Math.floor((now - signupDate) / (1000 * 60 * 60 * 24));

        // Update metrics
        await query(`
            UPDATE onboarding_progress
            SET total_logins = total_logins + 1,
                days_since_signup = ?,
                updated_at = NOW()
            WHERE user_id = ?
        `, [daysSinceSignup, userId]);
    }

    /**
     * Check if user has abandoned onboarding
     * @param {number} userId - User ID
     * @param {number} inactiveDays - Days of inactivity to consider abandoned (default: 7)
     * @returns {Promise<boolean>} True if abandoned
     */
    async isOnboardingAbandoned(userId, inactiveDays = 7) {
        const progress = await this.getProgress(userId);

        if (!progress || progress.onboarding_completed) {
            return false;
        }

        const lastUpdate = new Date(progress.updated_at);
        const now = new Date();
        const daysSinceUpdate = Math.floor((now - lastUpdate) / (1000 * 60 * 60 * 24));

        return daysSinceUpdate >= inactiveDays;
    }

    /**
     * Mark onboarding as abandoned
     * @param {number} userId - User ID
     * @returns {Promise<void>}
     */
    async markAbandoned(userId) {
        await query(`
            UPDATE onboarding_progress
            SET abandoned_at = NOW(),
                updated_at = NOW()
            WHERE user_id = ? AND onboarding_completed = FALSE
        `, [userId]);

        await this.trackEvent(userId, 'onboarding_abandoned', null);

        console.log(`⚠️  Marked onboarding as abandoned for user ${userId}`);
    }

    /**
     * Get onboarding analytics/stats
     * @returns {Promise<Object>} Analytics data
     */
    async getOnboardingAnalytics() {
        // Overall completion stats
        const overall = await query(`
            SELECT
                COUNT(*) as total_users,
                SUM(CASE WHEN onboarding_completed = TRUE THEN 1 ELSE 0 END) as completed_users,
                SUM(CASE WHEN abandoned_at IS NOT NULL THEN 1 ELSE 0 END) as abandoned_users,
                AVG(completion_percentage) as avg_completion,
                AVG(CASE WHEN onboarding_completed = TRUE
                    THEN TIMESTAMPDIFF(HOUR, started_at, completed_at)
                    ELSE NULL
                END) as avg_completion_hours
            FROM onboarding_progress
        `);

        // Step completion rates
        const stepStats = await query(`
            SELECT
                os.step_key,
                os.step_name,
                os.required,
                os.step_order,
                COUNT(DISTINCT op.user_id) as total_users,
                SUM(CASE WHEN JSON_CONTAINS(op.completed_steps, JSON_QUOTE(os.step_key))
                    THEN 1 ELSE 0 END) as completed_count,
                SUM(CASE WHEN JSON_CONTAINS(op.skipped_steps, JSON_QUOTE(os.step_key))
                    THEN 1 ELSE 0 END) as skipped_count
            FROM onboarding_steps os
            CROSS JOIN onboarding_progress op
            WHERE os.enabled = TRUE
            GROUP BY os.step_key, os.step_name, os.required, os.step_order
            ORDER BY os.step_order ASC
        `);

        // Recent events (last 7 days)
        const recentEvents = await query(`
            SELECT
                DATE(created_at) as event_date,
                event_type,
                COUNT(*) as event_count
            FROM onboarding_events
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
            GROUP BY DATE(created_at), event_type
            ORDER BY event_date DESC, event_count DESC
        `);

        return {
            overall: overall[0],
            stepStats: stepStats,
            recentEvents: recentEvents
        };
    }

    /**
     * Get users who need onboarding follow-up
     * @param {number} inactiveDays - Days of inactivity
     * @returns {Promise<Array>} Users needing follow-up
     */
    async getUsersNeedingFollowup(inactiveDays = 3) {
        return await query(`
            SELECT
                op.user_id,
                u.email,
                op.current_step,
                op.completion_percentage,
                op.updated_at,
                DATEDIFF(NOW(), op.updated_at) as days_inactive
            FROM onboarding_progress op
            JOIN users u ON op.user_id = u.id
            WHERE op.onboarding_completed = FALSE
            AND op.abandoned_at IS NULL
            AND op.updated_at < DATE_SUB(NOW(), INTERVAL ? DAY)
            ORDER BY days_inactive DESC
        `, [inactiveDays]);
    }
}

module.exports = new OnboardingService();
