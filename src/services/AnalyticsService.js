const { query } = require('../../config/database');
const crypto = require('crypto');

/**
 * AnalyticsService - User behavior analytics and engagement tracking
 *
 * Features:
 * - Session tracking and management
 * - Activity logging (page views, API calls)
 * - Engagement metrics calculation
 * - Business intelligence events
 * - Cohort analysis
 * - Funnel tracking
 */
class AnalyticsService {
    /**
     * Create or update user session
     * @param {number} userId - User ID
     * @param {number} refreshTokenId - Refresh token ID (optional)
     * @param {string} ipAddress - IP address
     * @param {string} userAgent - User agent
     * @returns {Promise<number>} Session ID
     */
    async createSession(userId, refreshTokenId, ipAddress, userAgent) {
        // Parse device info from user agent
        const deviceInfo = this.parseUserAgent(userAgent);

        // Generate session token (SHA-256 of random bytes)
        const sessionId = crypto.randomBytes(32).toString('hex');
        const sessionToken = crypto.createHash('sha256').update(sessionId).digest('hex');

        // Create session
        const result = await query(`
            INSERT INTO user_sessions (
                user_id,
                session_token,
                refresh_token_id,
                ip_address,
                user_agent,
                device_type,
                browser,
                os,
                started_at,
                last_activity_at,
                is_active,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), TRUE, NOW())
        `, [
            userId,
            sessionToken,
            refreshTokenId,
            ipAddress,
            userAgent,
            deviceInfo.deviceType,
            deviceInfo.browser,
            deviceInfo.os
        ]);

        // Update user session stats
        await query(`
            UPDATE users
            SET first_session_at = COALESCE(first_session_at, NOW()),
                last_session_at = NOW(),
                total_sessions = total_sessions + 1
            WHERE id = ?
        `, [userId]);

        console.log(`📊 Created session ${result.insertId} for user ${userId}`);

        return result.insertId;
    }

    /**
     * End user session
     * @param {number} sessionId - Session ID
     * @param {string} reason - End reason (logout, timeout, expired, token_revoked)
     * @returns {Promise<void>}
     */
    async endSession(sessionId, reason = 'logout') {
        // Calculate session duration
        const sessions = await query(`
            SELECT started_at FROM user_sessions WHERE id = ?
        `, [sessionId]);

        if (sessions.length === 0) {
            return;
        }

        const startedAt = new Date(sessions[0].started_at);
        const now = new Date();
        const durationSeconds = Math.floor((now - startedAt) / 1000);

        // End session
        await query(`
            UPDATE user_sessions
            SET is_active = FALSE,
                ended_at = NOW(),
                ended_reason = ?,
                duration_seconds = ?,
                updated_at = NOW()
            WHERE id = ?
        `, [reason, durationSeconds, sessionId]);

        console.log(`📊 Ended session ${sessionId} (${reason}, ${durationSeconds}s)`);
    }

    /**
     * Update session activity (heartbeat)
     * @param {number} sessionId - Session ID
     * @returns {Promise<void>}
     */
    async updateSessionActivity(sessionId) {
        await query(`
            UPDATE user_sessions
            SET last_activity_at = NOW(),
                updated_at = NOW()
            WHERE id = ? AND is_active = TRUE
        `, [sessionId]);
    }

    /**
     * Log user activity
     * @param {number} userId - User ID
     * @param {number} sessionId - Session ID (optional)
     * @param {string} activityType - Activity type (page_view, api_call, upload, download)
     * @param {string} activityCategory - Category (navigation, content, settings, billing)
     * @param {string} endpoint - Endpoint or URL
     * @param {string} httpMethod - HTTP method
     * @param {string} ipAddress - IP address
     * @param {string} userAgent - User agent
     * @param {Object} metadata - Additional metadata
     * @param {number} responseTimeMs - Response time in milliseconds
     * @param {number} statusCode - HTTP status code
     * @returns {Promise<number>} Activity log ID
     */
    async logActivity(userId, sessionId, activityType, activityCategory, endpoint, httpMethod, ipAddress, userAgent, metadata = null, responseTimeMs = null, statusCode = null) {
        const result = await query(`
            INSERT INTO user_activity_log (
                user_id,
                session_id,
                activity_type,
                activity_category,
                endpoint,
                http_method,
                ip_address,
                user_agent,
                metadata,
                response_time_ms,
                status_code,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
            userId,
            sessionId,
            activityType,
            activityCategory,
            endpoint,
            httpMethod,
            ipAddress,
            userAgent,
            metadata ? JSON.stringify(metadata) : null,
            responseTimeMs,
            statusCode
        ]);

        // Increment session counters
        if (sessionId) {
            if (activityType === 'page_view') {
                await query(`
                    UPDATE user_sessions
                    SET page_views = page_views + 1,
                        updated_at = NOW()
                    WHERE id = ?
                `, [sessionId]);
            } else {
                await query(`
                    UPDATE user_sessions
                    SET actions_count = actions_count + 1,
                        updated_at = NOW()
                    WHERE id = ?
                `, [sessionId]);
            }
        }

        return result.insertId;
    }

    /**
     * Track analytics event (business intelligence)
     * @param {string} eventName - Event name (signup_completed, payment_made, etc)
     * @param {string} eventCategory - Event category (authentication, billing, etc)
     * @param {number} userId - User ID (null for anonymous)
     * @param {number} sessionId - Session ID (optional)
     * @param {Object} properties - Event properties
     * @param {string} ipAddress - IP address
     * @param {string} userAgent - User agent
     * @param {string} referrer - Referrer URL
     * @param {Object} utm - UTM parameters
     * @returns {Promise<number>} Event ID
     */
    async trackEvent(eventName, eventCategory, userId, sessionId, properties, ipAddress, userAgent, referrer = null, utm = null) {
        const result = await query(`
            INSERT INTO analytics_events (
                event_name,
                event_category,
                user_id,
                session_id,
                properties,
                ip_address,
                user_agent,
                referrer,
                utm_source,
                utm_medium,
                utm_campaign,
                utm_term,
                utm_content,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
            eventName,
            eventCategory,
            userId,
            sessionId,
            properties ? JSON.stringify(properties) : null,
            ipAddress,
            userAgent,
            referrer,
            utm?.source || null,
            utm?.medium || null,
            utm?.campaign || null,
            utm?.term || null,
            utm?.content || null
        ]);

        console.log(`📊 Tracked event: ${eventName} (category: ${eventCategory})`);

        return result.insertId;
    }

    /**
     * Calculate and update daily engagement metrics
     * @param {number} userId - User ID
     * @param {Date} date - Date (defaults to today)
     * @returns {Promise<void>}
     */
    async updateDailyEngagementMetrics(userId, date = new Date()) {
        const dateStr = date.toISOString().split('T')[0];

        // Get session metrics for the day
        const sessionMetrics = await query(`
            SELECT
                COUNT(*) as sessions_count,
                SUM(duration_seconds) as total_duration,
                AVG(duration_seconds) as avg_duration,
                SUM(page_views) as page_views,
                SUM(actions_count) as actions_count,
                MIN(started_at) as first_activity,
                MAX(COALESCE(ended_at, last_activity_at)) as last_activity,
                SUM(CASE WHEN device_type = 'desktop' THEN 1 ELSE 0 END) as desktop_sessions,
                SUM(CASE WHEN device_type = 'mobile' THEN 1 ELSE 0 END) as mobile_sessions,
                SUM(CASE WHEN device_type = 'tablet' THEN 1 ELSE 0 END) as tablet_sessions
            FROM user_sessions
            WHERE user_id = ?
            AND DATE(started_at) = ?
        `, [userId, dateStr]);

        const metrics = sessionMetrics[0];

        // Get activity counts by category
        const activityCounts = await query(`
            SELECT
                SUM(CASE WHEN activity_type = 'upload' THEN 1 ELSE 0 END) as uploads_count,
                SUM(CASE WHEN activity_type = 'download' THEN 1 ELSE 0 END) as downloads_count,
                SUM(CASE WHEN activity_category = 'settings' THEN 1 ELSE 0 END) as settings_changes,
                SUM(CASE WHEN endpoint LIKE '%profile%' THEN 1 ELSE 0 END) as profile_updates
            FROM user_activity_log
            WHERE user_id = ?
            AND DATE(created_at) = ?
        `, [userId, dateStr]);

        const activity = activityCounts[0];

        // Calculate engagement score (0-100)
        const engagementScore = this.calculateEngagementScore({
            sessions: metrics.sessions_count || 0,
            duration: metrics.total_duration || 0,
            pageViews: metrics.page_views || 0,
            actions: metrics.actions_count || 0,
            uploads: activity.uploads_count || 0
        });

        // Upsert daily metrics
        await query(`
            INSERT INTO user_engagement_metrics (
                user_id,
                date,
                sessions_count,
                total_session_duration_seconds,
                avg_session_duration_seconds,
                page_views,
                api_calls,
                actions_count,
                uploads_count,
                downloads_count,
                profile_updates,
                settings_changes,
                desktop_sessions,
                mobile_sessions,
                tablet_sessions,
                first_activity_at,
                last_activity_at,
                engagement_score,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
            ON DUPLICATE KEY UPDATE
                sessions_count = VALUES(sessions_count),
                total_session_duration_seconds = VALUES(total_session_duration_seconds),
                avg_session_duration_seconds = VALUES(avg_session_duration_seconds),
                page_views = VALUES(page_views),
                actions_count = VALUES(actions_count),
                uploads_count = VALUES(uploads_count),
                downloads_count = VALUES(downloads_count),
                profile_updates = VALUES(profile_updates),
                settings_changes = VALUES(settings_changes),
                desktop_sessions = VALUES(desktop_sessions),
                mobile_sessions = VALUES(mobile_sessions),
                tablet_sessions = VALUES(tablet_sessions),
                first_activity_at = VALUES(first_activity_at),
                last_activity_at = VALUES(last_activity_at),
                engagement_score = VALUES(engagement_score),
                updated_at = NOW()
        `, [
            userId,
            dateStr,
            metrics.sessions_count || 0,
            metrics.total_duration || 0,
            Math.round(metrics.avg_duration || 0),
            metrics.page_views || 0,
            metrics.actions_count || 0,
            metrics.actions_count || 0,
            activity.uploads_count || 0,
            activity.downloads_count || 0,
            activity.profile_updates || 0,
            activity.settings_changes || 0,
            metrics.desktop_sessions || 0,
            metrics.mobile_sessions || 0,
            metrics.tablet_sessions || 0,
            metrics.first_activity,
            metrics.last_activity,
            engagementScore
        ]);

        // Update user lifetime engagement score
        await this.updateLifetimeEngagementScore(userId);

        console.log(`📊 Updated engagement metrics for user ${userId} (${dateStr}, score: ${engagementScore})`);
    }

    /**
     * Calculate engagement score (0-100)
     * @param {Object} metrics - Metrics object
     * @returns {number} Engagement score
     */
    calculateEngagementScore(metrics) {
        let score = 0;

        // Sessions (max 20 points)
        score += Math.min(metrics.sessions * 5, 20);

        // Duration (max 25 points) - 1 point per 2 minutes
        score += Math.min(Math.floor(metrics.duration / 120), 25);

        // Page views (max 20 points)
        score += Math.min(metrics.pageViews * 2, 20);

        // Actions (max 20 points)
        score += Math.min(metrics.actions * 2, 20);

        // Content creation (max 15 points)
        score += Math.min(metrics.uploads * 5, 15);

        return Math.min(Math.round(score), 100);
    }

    /**
     * Update user lifetime engagement score
     * @param {number} userId - User ID
     * @returns {Promise<void>}
     */
    async updateLifetimeEngagementScore(userId) {
        // Get average engagement score from last 30 days
        const result = await query(`
            SELECT AVG(engagement_score) as avg_score
            FROM user_engagement_metrics
            WHERE user_id = ?
            AND date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        `, [userId]);

        const avgScore = Math.round(result[0].avg_score || 0);

        await query(`
            UPDATE users
            SET lifetime_engagement_score = ?
            WHERE id = ?
        `, [avgScore, userId]);
    }

    /**
     * Track funnel event
     * @param {string} funnelName - Funnel name (signup_funnel, onboarding_funnel, etc)
     * @param {string} funnelStep - Step name
     * @param {number} stepOrder - Step order
     * @param {string} eventType - Event type (step_started, step_completed, step_abandoned)
     * @param {number} userId - User ID (null for anonymous)
     * @param {number} sessionId - Session ID (optional)
     * @param {string} ipAddress - IP address
     * @param {Object} metadata - Additional metadata
     * @returns {Promise<number>} Funnel event ID
     */
    async trackFunnelEvent(funnelName, funnelStep, stepOrder, eventType, userId, sessionId, ipAddress, metadata = null) {
        const result = await query(`
            INSERT INTO funnel_events (
                funnel_name,
                funnel_step,
                step_order,
                event_type,
                user_id,
                session_id,
                ip_address,
                metadata,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
            funnelName,
            funnelStep,
            stepOrder,
            eventType,
            userId,
            sessionId,
            ipAddress,
            metadata ? JSON.stringify(metadata) : null
        ]);

        return result.insertId;
    }

    /**
     * Get user engagement analytics
     * @param {number} userId - User ID
     * @param {number} days - Number of days (default 30)
     * @returns {Promise<Object>} Analytics data
     */
    async getUserEngagementAnalytics(userId, days = 30) {
        // Daily metrics
        const dailyMetrics = await query(`
            SELECT * FROM user_engagement_metrics
            WHERE user_id = ?
            AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            ORDER BY date DESC
        `, [userId, days]);

        // Session stats
        const sessionStats = await query(`
            SELECT
                COUNT(*) as total_sessions,
                SUM(duration_seconds) as total_duration,
                AVG(duration_seconds) as avg_duration,
                SUM(page_views) as total_page_views,
                SUM(actions_count) as total_actions
            FROM user_sessions
            WHERE user_id = ?
            AND started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        `, [userId, days]);

        // Device breakdown
        const deviceBreakdown = await query(`
            SELECT
                device_type,
                COUNT(*) as session_count
            FROM user_sessions
            WHERE user_id = ?
            AND started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY device_type
        `, [userId, days]);

        return {
            dailyMetrics: dailyMetrics,
            sessionStats: sessionStats[0],
            deviceBreakdown: deviceBreakdown
        };
    }

    /**
     * Get platform analytics (admin)
     * @param {number} days - Number of days
     * @returns {Promise<Object>} Platform analytics
     */
    async getPlatformAnalytics(days = 30) {
        // Overall stats
        const overall = await query(`
            SELECT
                COUNT(DISTINCT user_id) as active_users,
                COUNT(*) as total_sessions,
                SUM(duration_seconds) as total_duration,
                AVG(duration_seconds) as avg_session_duration,
                SUM(page_views) as total_page_views,
                SUM(actions_count) as total_actions
            FROM user_sessions
            WHERE started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        `, [days]);

        // Daily active users
        const dailyActiveUsers = await query(`
            SELECT
                DATE(started_at) as date,
                COUNT(DISTINCT user_id) as active_users
            FROM user_sessions
            WHERE started_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY DATE(started_at)
            ORDER BY date DESC
        `, [days]);

        // Top events
        const topEvents = await query(`
            SELECT
                event_name,
                event_category,
                COUNT(*) as event_count
            FROM analytics_events
            WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            GROUP BY event_name, event_category
            ORDER BY event_count DESC
            LIMIT 20
        `, [days]);

        // Engagement distribution
        const engagementDistribution = await query(`
            SELECT
                CASE
                    WHEN engagement_score >= 80 THEN 'high'
                    WHEN engagement_score >= 50 THEN 'medium'
                    WHEN engagement_score >= 20 THEN 'low'
                    ELSE 'very_low'
                END as engagement_level,
                COUNT(DISTINCT user_id) as user_count
            FROM user_engagement_metrics
            WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            GROUP BY engagement_level
        `, [days]);

        return {
            overall: overall[0],
            dailyActiveUsers: dailyActiveUsers,
            topEvents: topEvents,
            engagementDistribution: engagementDistribution
        };
    }

    /**
     * Parse user agent string
     * @param {string} userAgent - User agent string
     * @returns {Object} Parsed info
     */
    parseUserAgent(userAgent) {
        if (!userAgent) {
            return { deviceType: 'unknown', browser: 'unknown', os: 'unknown' };
        }

        // Simple parsing (in production, use a library like ua-parser-js)
        let deviceType = 'desktop';
        if (/mobile/i.test(userAgent)) deviceType = 'mobile';
        if (/tablet|ipad/i.test(userAgent)) deviceType = 'tablet';

        let browser = 'unknown';
        if (/chrome/i.test(userAgent)) browser = 'Chrome';
        else if (/safari/i.test(userAgent)) browser = 'Safari';
        else if (/firefox/i.test(userAgent)) browser = 'Firefox';
        else if (/edge/i.test(userAgent)) browser = 'Edge';

        let os = 'unknown';
        if (/windows/i.test(userAgent)) os = 'Windows';
        else if (/mac/i.test(userAgent)) os = 'macOS';
        else if (/linux/i.test(userAgent)) os = 'Linux';
        else if (/android/i.test(userAgent)) os = 'Android';
        else if (/ios|iphone|ipad/i.test(userAgent)) os = 'iOS';

        return { deviceType, browser, os };
    }
}

module.exports = new AnalyticsService();
