/**
 * PasswordResetService - Handle password reset/recovery
 * Phase 1.2 of Authentication & Onboarding Implementation Plan
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const emailService = require('./EmailService');
const { query } = require('../../config/database');

class PasswordResetService {
    constructor() {
        this.tokenExpiryMinutes = parseInt(process.env.PASSWORD_RESET_EXPIRY_MINUTES) || 60;
        this.siteUrl = process.env.API_BASE_URL || 'http://localhost:3000';
        this.siteName = process.env.SITE_NAME || 'MuseNest';
        this.rateLimitMinutes = 5; // Minimum time between reset requests
    }

    /**
     * Generate a cryptographically secure reset token
     * @private
     */
    _generateToken() {
        return crypto.randomBytes(32).toString('hex');
    }

    /**
     * Hash a token using SHA-256
     * @private
     */
    _hashToken(token) {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    /**
     * Send password reset email
     * @param {string} email - User's email address
     * @param {string} ipAddress - Request IP address (optional)
     * @param {string} userAgent - Request user agent (optional)
     * @returns {Promise<Object>} Result with success status and message
     */
    async sendPasswordResetEmail(email, ipAddress = null, userAgent = null) {
        try {
            // Find user by email
            const users = await query(`
                SELECT id, email, last_password_reset_request
                FROM users
                WHERE email = ? AND is_active = true
            `, [email]);

            if (users.length === 0) {
                // Don't reveal that user doesn't exist (security best practice)
                return {
                    success: true,
                    message: 'If an account exists with this email, you will receive a password reset link shortly'
                };
            }

            const user = users[0];

            // Rate limiting check
            if (user.last_password_reset_request) {
                const lastRequest = new Date(user.last_password_reset_request);
                const now = new Date();
                const minutesSinceLastRequest = (now - lastRequest) / (1000 * 60);

                if (minutesSinceLastRequest < this.rateLimitMinutes) {
                    return {
                        success: false,
                        error: 'rate_limited',
                        message: `Please wait ${this.rateLimitMinutes} minutes before requesting another password reset`
                    };
                }
            }

            // Generate reset token
            const token = this._generateToken();
            const tokenHash = this._hashToken(token);

            // Calculate expiry
            const expiresAt = new Date();
            expiresAt.setMinutes(expiresAt.getMinutes() + this.tokenExpiryMinutes);

            // Store reset token
            await query(`
                INSERT INTO password_reset_tokens (
                    user_id,
                    email,
                    token_hash,
                    expires_at,
                    ip_address,
                    user_agent,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, NOW())
            `, [user.id, email, tokenHash, expiresAt, ipAddress, userAgent]);

            // Update last reset request time
            await query(`
                UPDATE users
                SET last_password_reset_request = NOW()
                WHERE id = ?
            `, [user.id]);

            // Generate reset link
            const resetLink = `${this.siteUrl}/reset-password?token=${token}&email=${encodeURIComponent(email)}`;

            // Queue password reset email
            await emailService.queueEmail({
                to: email,
                templateName: 'password_reset',
                templateData: {
                    siteName: this.siteName,
                    resetLink: resetLink,
                    expiryMinutes: this.tokenExpiryMinutes
                },
                emailType: 'password_reset',
                userId: user.id,
                priority: 2 // High priority (urgent)
            });

            console.log(`🔐 Password reset email queued for user ${user.id} (${email})`);

            return {
                success: true,
                message: 'If an account exists with this email, you will receive a password reset link shortly'
            };

        } catch (error) {
            console.error('Password reset email error:', error);
            throw error;
        }
    }

    /**
     * Verify reset token and get user info
     * @param {string} email - User's email address
     * @param {string} token - Reset token (unhashed)
     * @returns {Promise<Object>} Result with user info or error
     */
    async verifyResetToken(email, token) {
        try {
            const tokenHash = this._hashToken(token);

            // Find valid reset token
            const tokens = await query(`
                SELECT prt.*, u.id as user_id, u.email
                FROM password_reset_tokens prt
                JOIN users u ON prt.user_id = u.id
                WHERE prt.email = ?
                  AND prt.token_hash = ?
                  AND prt.used_at IS NULL
                  AND prt.expires_at > NOW()
                  AND u.is_active = true
                ORDER BY prt.created_at DESC
                LIMIT 1
            `, [email, tokenHash]);

            if (tokens.length === 0) {
                return {
                    success: false,
                    error: 'invalid_token',
                    message: 'Invalid or expired password reset token'
                };
            }

            return {
                success: true,
                userId: tokens[0].user_id,
                email: tokens[0].email,
                tokenId: tokens[0].id
            };

        } catch (error) {
            console.error('Reset token verification error:', error);
            throw error;
        }
    }

    /**
     * Reset password with token
     * @param {string} email - User's email address
     * @param {string} token - Reset token (unhashed)
     * @param {string} newPassword - New password
     * @returns {Promise<Object>} Result with success status and message
     */
    async resetPassword(email, token, newPassword) {
        try {
            // Verify token first
            const verification = await this.verifyResetToken(email, token);
            if (!verification.success) {
                return verification;
            }

            // Hash new password
            const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
            const passwordHash = await bcrypt.hash(newPassword, saltRounds);

            // Update password and increment token version (invalidates all refresh tokens)
            await query(`
                UPDATE users
                SET password_hash = ?,
                    password_changed_at = NOW(),
                    token_version = token_version + 1,
                    updated_at = NOW()
                WHERE id = ?
            `, [passwordHash, verification.userId]);

            // Mark token as used
            const tokenHash = this._hashToken(token);
            await query(`
                UPDATE password_reset_tokens
                SET used_at = NOW()
                WHERE token_hash = ?
            `, [tokenHash]);

            // Revoke all existing refresh tokens (force re-login)
            await query(`
                UPDATE refresh_tokens
                SET revoked_at = NOW()
                WHERE user_id = ? AND revoked_at IS NULL
            `, [verification.userId]);

            console.log(`✅ Password reset successful for user ${verification.userId} (${email})`);

            return {
                success: true,
                message: 'Password reset successfully. Please log in with your new password.'
            };

        } catch (error) {
            console.error('Password reset error:', error);
            throw error;
        }
    }

    /**
     * Change password for authenticated user (requires current password)
     * @param {number} userId - User ID
     * @param {string} currentPassword - Current password
     * @param {string} newPassword - New password
     * @returns {Promise<Object>} Result with success status and message
     */
    async changePassword(userId, currentPassword, newPassword) {
        try {
            // Get user's current password hash
            const users = await query(`
                SELECT password_hash
                FROM users
                WHERE id = ? AND is_active = true
            `, [userId]);

            if (users.length === 0) {
                return {
                    success: false,
                    error: 'user_not_found',
                    message: 'User not found'
                };
            }

            // Verify current password
            const isPasswordValid = await bcrypt.compare(currentPassword, users[0].password_hash);
            if (!isPasswordValid) {
                return {
                    success: false,
                    error: 'invalid_password',
                    message: 'Current password is incorrect'
                };
            }

            // Hash new password
            const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
            const passwordHash = await bcrypt.hash(newPassword, saltRounds);

            // Update password and increment token version
            await query(`
                UPDATE users
                SET password_hash = ?,
                    password_changed_at = NOW(),
                    token_version = token_version + 1,
                    updated_at = NOW()
                WHERE id = ?
            `, [passwordHash, userId]);

            // Revoke all existing refresh tokens (force re-login on other devices)
            await query(`
                UPDATE refresh_tokens
                SET revoked_at = NOW()
                WHERE user_id = ? AND revoked_at IS NULL
            `, [userId]);

            console.log(`✅ Password changed for user ${userId}`);

            return {
                success: true,
                message: 'Password changed successfully. You have been logged out on all devices.'
            };

        } catch (error) {
            console.error('Password change error:', error);
            throw error;
        }
    }

    /**
     * Clean up expired reset tokens
     */
    async cleanupExpiredTokens() {
        const result = await query(`
            DELETE FROM password_reset_tokens
            WHERE expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
        `);

        if (result.affectedRows > 0) {
            console.log(`🧹 Cleaned up ${result.affectedRows} expired password reset tokens`);
        }

        return result.affectedRows;
    }

    /**
     * Get password reset history for a user
     * @param {number} userId - User ID
     * @param {number} limit - Number of records to return
     * @returns {Promise<Array>} Array of password reset attempts
     */
    async getResetHistory(userId, limit = 10) {
        const history = await query(`
            SELECT
                id,
                email,
                expires_at,
                used_at,
                ip_address,
                created_at
            FROM password_reset_tokens
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ?
        `, [userId, limit]);

        return history;
    }
}

// Export singleton instance
module.exports = new PasswordResetService();
