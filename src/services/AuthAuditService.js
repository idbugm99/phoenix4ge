const { query } = require('../../config/database');

/**
 * AuthAuditService - Comprehensive authentication audit logging
 *
 * Features:
 * - Log all authentication events (login, logout, password changes, etc.)
 * - Risk scoring for anomaly detection
 * - Daily summary aggregation for dashboard performance
 * - Suspicious activity detection and alerting
 * - GDPR-compliant 90-day retention
 *
 * Event Types:
 * - login, logout, login_failed
 * - register, email_verified
 * - password_change, password_reset, password_reset_request
 * - token_refresh, token_revoke
 * - session_created, session_revoked
 * - account_locked, account_unlocked
 * - mfa_enabled, mfa_disabled (future)
 * - oauth_linked, oauth_unlinked (future)
 */
class AuthAuditService {
    /**
     * Log an authentication event
     * @param {Object} eventData - Event data
     * @param {string} eventData.eventType - Type of event
     * @param {string} eventData.eventCategory - Category (authentication, authorization, account_management, security, session)
     * @param {number|null} eventData.userId - User ID
     * @param {string|null} eventData.email - User email
     * @param {string|null} eventData.username - Username
     * @param {boolean} eventData.success - Whether event was successful
     * @param {string|null} eventData.failureReason - Reason for failure
     * @param {string|null} eventData.ipAddress - IP address
     * @param {string|null} eventData.userAgent - User agent string
     * @param {string|null} eventData.requestId - Request ID for correlation
     * @param {Object|null} eventData.metadata - Additional metadata
     * @returns {Promise<number>} Event ID
     */
    async logEvent(eventData) {
        try {
            const {
                eventType,
                eventCategory,
                userId = null,
                email = null,
                username = null,
                success,
                failureReason = null,
                ipAddress = null,
                userAgent = null,
                requestId = null,
                metadata = null
            } = eventData;

            // Calculate risk score
            const riskScore = await this.calculateRiskScore(eventData);
            const riskFactors = await this.identifyRiskFactors(eventData);

            // Insert audit log entry
            const result = await query(`
                INSERT INTO auth_audit_log (
                    event_type, event_category,
                    user_id, email, username,
                    success, failure_reason,
                    ip_address, user_agent, request_id,
                    risk_score, risk_factors,
                    metadata,
                    created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
            `, [
                eventType, eventCategory,
                userId, email, username,
                success, failureReason,
                ipAddress, userAgent, requestId,
                riskScore, riskFactors ? JSON.stringify(riskFactors) : null,
                metadata ? JSON.stringify(metadata) : null
            ]);

            const eventId = result.insertId;

            // Update user's last audit event timestamp
            if (userId) {
                await query(`
                    UPDATE users
                    SET last_audit_event_at = NOW()
                    WHERE id = ?
                `, [userId]);
            }

            // Update daily summary asynchronously (don't wait)
            this.updateDailySummary(userId, eventType, success, ipAddress, userAgent).catch(err => {
                console.error('Error updating daily summary:', err);
            });

            // Check for suspicious activity
            if (riskScore >= 70) {
                this.createSuspiciousActivityAlert({
                    userId,
                    eventId,
                    riskScore,
                    riskFactors,
                    ipAddress,
                    metadata
                }).catch(err => {
                    console.error('Error creating suspicious activity alert:', err);
                });
            }

            console.log(`📋 Audit: ${eventType} - User ${userId || email} - Risk ${riskScore}`);
            return eventId;

        } catch (error) {
            console.error('Error logging audit event:', error);
            // Don't throw - audit logging failures shouldn't break application flow
            return null;
        }
    }

    /**
     * Calculate risk score for an event (0-100)
     * @param {Object} eventData - Event data
     * @returns {Promise<number>}
     */
    async calculateRiskScore(eventData) {
        let score = 0;

        // Base score for failure
        if (!eventData.success) {
            score += 20;
        }

        // Check for unusual activity patterns
        if (eventData.userId && eventData.ipAddress) {
            // Check if IP is new for this user
            const ipHistory = await query(`
                SELECT COUNT(*) as count
                FROM auth_audit_log
                WHERE user_id = ?
                AND ip_address = ?
                AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
            `, [eventData.userId, eventData.ipAddress]);

            if (ipHistory[0].count === 0) {
                score += 30; // New IP address
            }

            // Check for multiple recent failures
            const recentFailures = await query(`
                SELECT COUNT(*) as count
                FROM auth_audit_log
                WHERE user_id = ?
                AND success = FALSE
                AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
            `, [eventData.userId]);

            if (recentFailures[0].count >= 3) {
                score += 25; // Multiple recent failures
            }

            // Check for unusual time (overnight activity)
            const hour = new Date().getHours();
            if (hour >= 2 && hour <= 5) {
                score += 15; // Unusual hours (2 AM - 5 AM)
            }
        }

        // High-risk event types
        const highRiskEvents = ['password_reset', 'account_locked', 'mfa_disabled'];
        if (highRiskEvents.includes(eventData.eventType)) {
            score += 20;
        }

        return Math.min(score, 100); // Cap at 100
    }

    /**
     * Identify risk factors for an event
     * @param {Object} eventData - Event data
     * @returns {Promise<Array<string>>}
     */
    async identifyRiskFactors(eventData) {
        const factors = [];

        if (!eventData.success) {
            factors.push('authentication_failure');
        }

        if (eventData.userId && eventData.ipAddress) {
            // Check for new IP
            const ipHistory = await query(`
                SELECT COUNT(*) as count
                FROM auth_audit_log
                WHERE user_id = ?
                AND ip_address = ?
                AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
            `, [eventData.userId, eventData.ipAddress]);

            if (ipHistory[0].count === 0) {
                factors.push('new_ip_address');
            }

            // Check for new device
            const deviceHistory = await query(`
                SELECT COUNT(*) as count
                FROM auth_audit_log
                WHERE user_id = ?
                AND user_agent = ?
                AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
            `, [eventData.userId, eventData.userAgent]);

            if (deviceHistory[0].count === 0) {
                factors.push('new_device');
            }

            // Check for rapid succession events (possible brute force)
            const recentEvents = await query(`
                SELECT COUNT(*) as count
                FROM auth_audit_log
                WHERE user_id = ?
                AND created_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE)
            `, [eventData.userId]);

            if (recentEvents[0].count >= 10) {
                factors.push('rapid_succession');
            }
        }

        // Unusual hours
        const hour = new Date().getHours();
        if (hour >= 2 && hour <= 5) {
            factors.push('unusual_hours');
        }

        return factors.length > 0 ? factors : null;
    }

    /**
     * Update daily summary for dashboard performance
     * @param {number} userId - User ID
     * @param {string} eventType - Event type
     * @param {boolean} success - Success status
     * @param {string} ipAddress - IP address
     * @param {string} userAgent - User agent
     * @returns {Promise<void>}
     */
    async updateDailySummary(userId, eventType, success, ipAddress, userAgent) {
        if (!userId) return;

        const today = new Date().toISOString().split('T')[0];

        // Check if summary exists for today
        const existing = await query(`
            SELECT id FROM auth_audit_summary
            WHERE user_id = ? AND date = ?
        `, [userId, today]);

        if (existing.length === 0) {
            // Create new summary
            await query(`
                INSERT INTO auth_audit_summary (
                    user_id, date,
                    successful_logins, failed_logins,
                    password_changes, token_refreshes,
                    high_risk_events, unique_ip_addresses, unique_devices,
                    created_at, updated_at
                )
                VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, NOW(), NOW())
            `, [userId, today]);
        }

        // Update counters
        let updateClause = '';
        if (eventType === 'login' && success) {
            updateClause = 'successful_logins = successful_logins + 1';
        } else if (eventType === 'login' && !success) {
            updateClause = 'failed_logins = failed_logins + 1';
        } else if (eventType === 'password_change' || eventType === 'password_reset') {
            updateClause = 'password_changes = password_changes + 1';
        } else if (eventType === 'token_refresh') {
            updateClause = 'token_refreshes = token_refreshes + 1';
        }

        if (updateClause) {
            await query(`
                UPDATE auth_audit_summary
                SET ${updateClause}, updated_at = NOW()
                WHERE user_id = ? AND date = ?
            `, [userId, today]);
        }

        // Update unique IP and device counts
        await this.updateUniqueMetrics(userId, today);
    }

    /**
     * Update unique IP and device metrics
     * @param {number} userId - User ID
     * @param {string} date - Date (YYYY-MM-DD)
     * @returns {Promise<void>}
     */
    async updateUniqueMetrics(userId, date) {
        // Count unique IPs for the day
        const uniqueIPs = await query(`
            SELECT COUNT(DISTINCT ip_address) as count
            FROM auth_audit_log
            WHERE user_id = ?
            AND DATE(created_at) = ?
        `, [userId, date]);

        // Count unique devices (based on user agent)
        const uniqueDevices = await query(`
            SELECT COUNT(DISTINCT user_agent) as count
            FROM auth_audit_log
            WHERE user_id = ?
            AND DATE(created_at) = ?
        `, [userId, date]);

        await query(`
            UPDATE auth_audit_summary
            SET unique_ip_addresses = ?,
                unique_devices = ?,
                updated_at = NOW()
            WHERE user_id = ? AND date = ?
        `, [uniqueIPs[0].count, uniqueDevices[0].count, userId, date]);
    }

    /**
     * Create a suspicious activity alert
     * @param {Object} alertData - Alert data
     * @returns {Promise<number>} Alert ID
     */
    async createSuspiciousActivityAlert(alertData) {
        const {
            userId,
            eventId,
            riskScore,
            riskFactors,
            ipAddress,
            metadata
        } = alertData;

        // Determine alert type based on risk factors
        let alertType = 'unusual_activity';
        let severity = 'medium';

        if (riskFactors && riskFactors.includes('rapid_succession')) {
            alertType = 'multiple_failures';
            severity = 'high';
        }
        if (riskFactors && riskFactors.includes('new_ip_address') && riskFactors.includes('new_device')) {
            alertType = 'new_device';
            severity = 'medium';
        }
        if (riskScore >= 90) {
            severity = 'critical';
        }

        const description = `High-risk authentication event detected. Risk score: ${riskScore}. Factors: ${riskFactors ? riskFactors.join(', ') : 'unknown'}`;

        const result = await query(`
            INSERT INTO auth_suspicious_activity (
                user_id, alert_type, severity, description,
                triggering_event_id, ip_address, metadata,
                status, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 'new', NOW(), NOW())
        `, [
            userId,
            alertType,
            severity,
            description,
            eventId,
            ipAddress,
            metadata ? JSON.stringify(metadata) : null
        ]);

        console.log(`🚨 Suspicious activity alert created: ${alertType} (severity: ${severity})`);
        return result.insertId;
    }

    /**
     * Get audit log for a user
     * @param {number} userId - User ID
     * @param {number} limit - Number of records to return
     * @param {number} offset - Offset for pagination
     * @returns {Promise<Array>}
     */
    async getUserAuditLog(userId, limit = 50, offset = 0) {
        return await query(`
            SELECT
                id, event_type, event_category,
                success, failure_reason,
                ip_address, user_agent,
                risk_score, risk_factors,
                metadata, created_at
            FROM auth_audit_log
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `, [userId, limit, offset]);
    }

    /**
     * Get suspicious activity alerts for a user
     * @param {number} userId - User ID
     * @param {string} status - Filter by status (new, investigating, resolved, false_positive)
     * @returns {Promise<Array>}
     */
    async getSuspiciousActivityAlerts(userId = null, status = null) {
        let whereClause = [];
        let params = [];

        if (userId) {
            whereClause.push('user_id = ?');
            params.push(userId);
        }
        if (status) {
            whereClause.push('status = ?');
            params.push(status);
        }

        const where = whereClause.length > 0 ? 'WHERE ' + whereClause.join(' AND ') : '';

        return await query(`
            SELECT
                id, user_id, alert_type, severity, description,
                triggering_event_id, ip_address,
                status, resolved_at, resolution_notes,
                created_at, updated_at
            FROM auth_suspicious_activity
            ${where}
            ORDER BY created_at DESC
            LIMIT 100
        `, params);
    }

    /**
     * Get daily summary for a user
     * @param {number} userId - User ID
     * @param {number} days - Number of days to retrieve
     * @returns {Promise<Array>}
     */
    async getUserDailySummary(userId, days = 30) {
        return await query(`
            SELECT
                date,
                successful_logins, failed_logins,
                password_changes, token_refreshes,
                high_risk_events, unique_ip_addresses, unique_devices
            FROM auth_audit_summary
            WHERE user_id = ?
            AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            ORDER BY date DESC
        `, [userId, days]);
    }

    /**
     * Get audit statistics for monitoring/dashboard
     * @returns {Promise<Object>}
     */
    async getAuditStats() {
        // Total events by category (last 24 hours)
        const eventsByCategory = await query(`
            SELECT
                event_category,
                COUNT(*) as count,
                SUM(CASE WHEN success = TRUE THEN 1 ELSE 0 END) as successful,
                SUM(CASE WHEN success = FALSE THEN 1 ELSE 0 END) as failed
            FROM auth_audit_log
            WHERE created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
            GROUP BY event_category
        `);

        // High-risk events (last 24 hours)
        const highRiskEvents = await query(`
            SELECT COUNT(*) as count
            FROM auth_audit_log
            WHERE risk_score >= 70
            AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
        `);

        // Suspicious activity alerts by status
        const alertsByStatus = await query(`
            SELECT status, COUNT(*) as count
            FROM auth_suspicious_activity
            GROUP BY status
        `);

        // Most active users (last 7 days)
        const mostActiveUsers = await query(`
            SELECT
                user_id,
                email,
                COUNT(*) as event_count
            FROM auth_audit_log
            WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
            AND user_id IS NOT NULL
            GROUP BY user_id, email
            ORDER BY event_count DESC
            LIMIT 10
        `);

        return {
            eventsByCategory,
            highRiskEvents: highRiskEvents[0].count,
            alertsByStatus,
            mostActiveUsers
        };
    }

    /**
     * Cleanup old audit logs (GDPR compliance - 90-day retention)
     * @param {number} daysOld - Delete logs older than this many days
     * @returns {Promise<Object>} Counts of deleted records
     */
    async cleanupOldAuditLogs(daysOld = 90) {
        // Delete old audit logs
        const auditResult = await query(`
            DELETE FROM auth_audit_log
            WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
        `, [daysOld]);

        // Delete old summaries
        const summaryResult = await query(`
            DELETE FROM auth_audit_summary
            WHERE date < DATE_SUB(CURDATE(), INTERVAL ? DAY)
        `, [daysOld]);

        // Delete resolved suspicious activity (keep new/investigating)
        const alertResult = await query(`
            DELETE FROM auth_suspicious_activity
            WHERE resolved_at < DATE_SUB(NOW(), INTERVAL ? DAY)
            AND status IN ('resolved', 'false_positive')
        `, [daysOld]);

        console.log(`🧹 Audit cleanup: ${auditResult.affectedRows} logs, ${summaryResult.affectedRows} summaries, ${alertResult.affectedRows} alerts deleted`);

        return {
            auditLogs: auditResult.affectedRows,
            summaries: summaryResult.affectedRows,
            alerts: alertResult.affectedRows
        };
    }
}

module.exports = new AuthAuditService();
