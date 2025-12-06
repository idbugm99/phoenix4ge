const { query } = require('../../config/database');
const crypto = require('crypto');

/**
 * LoginAttemptService - Track login attempts and enforce account lockout
 *
 * Progressive Lockout Strategy:
 * - 5 failed attempts → 15 minutes lockout
 * - 10 failed attempts → 1 hour lockout
 * - 15 failed attempts → 24 hours lockout
 *
 * Features:
 * - Track all login attempts (success and failure)
 * - Progressive lockout based on failure count
 * - IP address and user agent tracking
 * - Automatic lockout expiry
 * - Reset on successful login
 */
class LoginAttemptService {
    /**
     * Record a login attempt
     * @param {string} email - User's email
     * @param {number|null} userId - User ID (null if user not found)
     * @param {boolean} success - Whether login was successful
     * @param {string} ipAddress - IP address of request
     * @param {string} userAgent - User agent string
     * @param {string|null} failureReason - Reason for failure (if applicable)
     * @returns {Promise<void>}
     */
    async recordAttempt(email, userId, success, ipAddress, userAgent, failureReason = null) {
        try {
            // Record in login_attempts table
            await query(`
                INSERT INTO login_attempts (
                    email, user_id, ip_address, user_agent,
                    success, failure_reason, attempted_at
                )
                VALUES (?, ?, ?, ?, ?, ?, NOW())
            `, [email, userId, ipAddress, userAgent, success, failureReason]);

            if (userId) {
                if (success) {
                    // Reset failed attempts on successful login
                    await query(`
                        UPDATE users
                        SET failed_login_attempts = 0,
                            account_locked_until = NULL,
                            last_failed_login_at = NULL,
                            updated_at = NOW()
                        WHERE id = ?
                    `, [userId]);
                } else {
                    // Increment failed attempts and calculate lockout
                    await this.incrementFailedAttempts(userId);
                }
            }

            console.log(`📝 Login attempt recorded: ${email} (${success ? 'SUCCESS' : 'FAILED'}) from ${ipAddress}`);
        } catch (error) {
            console.error('Error recording login attempt:', error);
            // Don't throw - logging failures shouldn't break login flow
        }
    }

    /**
     * Increment failed login attempts and apply progressive lockout
     * @param {number} userId - User ID
     * @returns {Promise<void>}
     */
    async incrementFailedAttempts(userId) {
        // Get current failed attempts count
        const users = await query(
            'SELECT failed_login_attempts FROM users WHERE id = ?',
            [userId]
        );

        if (users.length === 0) return;

        const currentAttempts = users[0].failed_login_attempts || 0;
        const newAttempts = currentAttempts + 1;

        // Calculate lockout duration based on progressive strategy
        let lockoutMinutes = 0;
        if (newAttempts >= 15) {
            lockoutMinutes = 24 * 60; // 24 hours
        } else if (newAttempts >= 10) {
            lockoutMinutes = 60; // 1 hour
        } else if (newAttempts >= 5) {
            lockoutMinutes = 15; // 15 minutes
        }

        if (lockoutMinutes > 0) {
            await query(`
                UPDATE users
                SET failed_login_attempts = ?,
                    account_locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE),
                    last_failed_login_at = NOW(),
                    updated_at = NOW()
                WHERE id = ?
            `, [newAttempts, lockoutMinutes, userId]);

            console.log(`🔒 Account locked for ${lockoutMinutes} minutes (${newAttempts} failed attempts)`);
        } else {
            await query(`
                UPDATE users
                SET failed_login_attempts = ?,
                    last_failed_login_at = NOW(),
                    updated_at = NOW()
                WHERE id = ?
            `, [newAttempts, userId]);
        }
    }

    /**
     * Check if account is currently locked
     * @param {string} email - User's email
     * @returns {Promise<{locked: boolean, lockedUntil: Date|null, attempts: number}>}
     */
    async checkAccountLockout(email) {
        const users = await query(`
            SELECT id, email, failed_login_attempts, account_locked_until
            FROM users
            WHERE email = ?
        `, [email]);

        if (users.length === 0) {
            return { locked: false, lockedUntil: null, attempts: 0 };
        }

        const user = users[0];
        const now = new Date();
        const lockedUntil = user.account_locked_until ? new Date(user.account_locked_until) : null;

        // Check if lockout has expired
        if (lockedUntil && lockedUntil > now) {
            return {
                locked: true,
                lockedUntil: lockedUntil,
                attempts: user.failed_login_attempts || 0,
                userId: user.id
            };
        }

        // Lockout has expired, clear it
        if (lockedUntil && lockedUntil <= now) {
            await query(`
                UPDATE users
                SET account_locked_until = NULL,
                    updated_at = NOW()
                WHERE id = ?
            `, [user.id]);

            return {
                locked: false,
                lockedUntil: null,
                attempts: user.failed_login_attempts || 0,
                userId: user.id
            };
        }

        return {
            locked: false,
            lockedUntil: null,
            attempts: user.failed_login_attempts || 0,
            userId: user.id
        };
    }

    /**
     * Get login attempt history for a user
     * @param {string|number} emailOrUserId - Email or user ID
     * @param {number} limit - Number of attempts to return
     * @returns {Promise<Array>}
     */
    async getLoginHistory(emailOrUserId, limit = 20) {
        let whereClause, params;

        if (typeof emailOrUserId === 'number') {
            whereClause = 'user_id = ?';
            params = [emailOrUserId, limit];
        } else {
            whereClause = 'email = ?';
            params = [emailOrUserId, limit];
        }

        const attempts = await query(`
            SELECT
                id,
                email,
                ip_address,
                user_agent,
                success,
                failure_reason,
                attempted_at
            FROM login_attempts
            WHERE ${whereClause}
            ORDER BY attempted_at DESC
            LIMIT ?
        `, params);

        return attempts;
    }

    /**
     * Get failed login attempts within a time window
     * @param {string} email - User's email
     * @param {number} minutes - Time window in minutes
     * @returns {Promise<number>}
     */
    async getRecentFailedAttempts(email, minutes = 30) {
        const results = await query(`
            SELECT COUNT(*) as count
            FROM login_attempts
            WHERE email = ?
            AND success = FALSE
            AND attempted_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)
        `, [email, minutes]);

        return results[0].count;
    }

    /**
     * Get failed attempts by IP address (for IP-based rate limiting)
     * @param {string} ipAddress - IP address
     * @param {number} minutes - Time window in minutes
     * @returns {Promise<number>}
     */
    async getRecentFailedAttemptsByIP(ipAddress, minutes = 30) {
        const results = await query(`
            SELECT COUNT(*) as count
            FROM login_attempts
            WHERE ip_address = ?
            AND success = FALSE
            AND attempted_at > DATE_SUB(NOW(), INTERVAL ? MINUTE)
        `, [ipAddress, minutes]);

        return results[0].count;
    }

    /**
     * Manually unlock an account (admin function)
     * @param {number} userId - User ID
     * @returns {Promise<void>}
     */
    async unlockAccount(userId) {
        await query(`
            UPDATE users
            SET failed_login_attempts = 0,
                account_locked_until = NULL,
                last_failed_login_at = NULL,
                updated_at = NOW()
            WHERE id = ?
        `, [userId]);

        console.log(`🔓 Account ${userId} manually unlocked`);
    }

    /**
     * Get lockout statistics for monitoring
     * @returns {Promise<Object>}
     */
    async getLockoutStats() {
        // Count currently locked accounts
        const lockedAccounts = await query(`
            SELECT COUNT(*) as count
            FROM users
            WHERE account_locked_until > NOW()
        `);

        // Count accounts with failed attempts
        const accountsWithFailures = await query(`
            SELECT COUNT(*) as count
            FROM users
            WHERE failed_login_attempts > 0
        `);

        // Recent failed attempts (last hour)
        const recentFailures = await query(`
            SELECT COUNT(*) as count
            FROM login_attempts
            WHERE success = FALSE
            AND attempted_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
        `);

        // Most targeted accounts (top 10 by failed attempts)
        const targetedAccounts = await query(`
            SELECT
                email,
                COUNT(*) as attempt_count,
                MAX(attempted_at) as last_attempt
            FROM login_attempts
            WHERE success = FALSE
            AND attempted_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
            GROUP BY email
            ORDER BY attempt_count DESC
            LIMIT 10
        `);

        return {
            currentlyLocked: lockedAccounts[0].count,
            accountsWithFailures: accountsWithFailures[0].count,
            recentFailures: recentFailures[0].count,
            mostTargeted: targetedAccounts
        };
    }

    /**
     * Cleanup old login attempts (data retention)
     * @param {number} daysOld - Delete attempts older than this many days
     * @returns {Promise<number>} Number of deleted records
     */
    async cleanupOldAttempts(daysOld = 90) {
        const result = await query(`
            DELETE FROM login_attempts
            WHERE attempted_at < DATE_SUB(NOW(), INTERVAL ? DAY)
        `, [daysOld]);

        console.log(`🧹 Cleaned up ${result.affectedRows} old login attempts (older than ${daysOld} days)`);
        return result.affectedRows;
    }
}

module.exports = new LoginAttemptService();
