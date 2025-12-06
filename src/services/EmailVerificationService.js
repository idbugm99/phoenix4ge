/**
 * EmailVerificationService - Handle email verification for user registration
 * Phase 1.1 of Authentication & Onboarding Implementation Plan
 */

const crypto = require('crypto');
const emailService = require('./EmailService');
const { query } = require('../../config/database');

class EmailVerificationService {
    constructor() {
        this.tokenExpiryHours = parseInt(process.env.EMAIL_VERIFICATION_EXPIRY_HOURS) || 24;
        this.siteUrl = process.env.API_BASE_URL || 'http://localhost:3000';
        this.siteName = process.env.SITE_NAME || 'MuseNest';
    }

    /**
     * Generate a cryptographically secure verification token
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
     * Send verification email to user
     * @param {number} userId - User ID
     * @param {string} email - User's email address
     * @param {string} tokenType - 'verification' or 'change_email'
     * @returns {Promise<string>} Verification token (unhashed)
     */
    async sendVerificationEmail(userId, email, tokenType = 'verification') {
        try {
            // Generate token
            const token = this._generateToken();
            const tokenHash = this._hashToken(token);

            // Calculate expiry
            const expiresAt = new Date();
            expiresAt.setHours(expiresAt.getHours() + this.tokenExpiryHours);

            // Create verification record
            await query(`
                INSERT INTO email_verifications (
                    user_id,
                    email,
                    token_hash,
                    token_type,
                    expires_at,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, NOW())
            `, [userId, email, tokenHash, tokenType, expiresAt]);

            // Generate verification link
            const verificationLink = `${this.siteUrl}/verify-email?token=${token}&email=${encodeURIComponent(email)}`;

            // Queue verification email
            await emailService.queueEmail({
                to: email,
                templateName: 'email_verification',
                templateData: {
                    siteName: this.siteName,
                    verificationLink: verificationLink,
                    expiryHours: this.tokenExpiryHours
                },
                emailType: 'verification',
                userId: userId,
                priority: 3 // High priority
            });

            console.log(`📧 Verification email queued for user ${userId} (${email})`);
            return token;

        } catch (error) {
            console.error('Failed to send verification email:', error);
            throw error;
        }
    }

    /**
     * Verify email with token
     * @param {string} email - User's email address
     * @param {string} token - Verification token (unhashed)
     * @returns {Promise<Object>} Result with success status and message
     */
    async verifyEmail(email, token) {
        try {
            // Hash the provided token
            const tokenHash = this._hashToken(token);

            // Find matching verification record
            const verifications = await query(`
                SELECT *
                FROM email_verifications
                WHERE email = ?
                  AND token_hash = ?
                  AND token_type = 'verification'
                  AND verified_at IS NULL
                  AND expires_at > NOW()
                ORDER BY created_at DESC
                LIMIT 1
            `, [email, tokenHash]);

            if (verifications.length === 0) {
                return {
                    success: false,
                    error: 'invalid_token',
                    message: 'Invalid or expired verification token'
                };
            }

            const verification = verifications[0];

            // Mark verification as verified
            await query(`
                UPDATE email_verifications
                SET verified_at = NOW()
                WHERE id = ?
            `, [verification.id]);

            // Update user record
            await query(`
                UPDATE users
                SET email_verified = TRUE,
                    email_verified_at = NOW(),
                    updated_at = NOW()
                WHERE id = ?
            `, [verification.user_id]);

            // Send welcome email
            await this._sendWelcomeEmail(verification.user_id, email);

            console.log(`✅ Email verified for user ${verification.user_id} (${email})`);

            return {
                success: true,
                userId: verification.user_id,
                message: 'Email verified successfully'
            };

        } catch (error) {
            console.error('Email verification error:', error);
            throw error;
        }
    }

    /**
     * Resend verification email
     * @param {string} email - User's email address
     * @returns {Promise<Object>} Result with success status and message
     */
    async resendVerificationEmail(email) {
        try {
            // Find user by email
            const users = await query(`
                SELECT id, email, email_verified
                FROM users
                WHERE email = ?
            `, [email]);

            if (users.length === 0) {
                return {
                    success: false,
                    error: 'user_not_found',
                    message: 'No account found with this email address'
                };
            }

            const user = users[0];

            if (user.email_verified) {
                return {
                    success: false,
                    error: 'already_verified',
                    message: 'This email address is already verified'
                };
            }

            // Check if a recent verification email was sent (rate limiting)
            const recentVerifications = await query(`
                SELECT COUNT(*) as count
                FROM email_verifications
                WHERE user_id = ?
                  AND created_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE)
            `, [user.id]);

            if (recentVerifications[0].count > 0) {
                return {
                    success: false,
                    error: 'rate_limited',
                    message: 'Please wait 5 minutes before requesting another verification email'
                };
            }

            // Send new verification email
            await this.sendVerificationEmail(user.id, email);

            return {
                success: true,
                message: 'Verification email sent successfully'
            };

        } catch (error) {
            console.error('Resend verification email error:', error);
            throw error;
        }
    }

    /**
     * Check if user's email is verified
     * @param {number} userId - User ID
     * @returns {Promise<boolean>} True if verified, false otherwise
     */
    async isEmailVerified(userId) {
        const users = await query(`
            SELECT email_verified
            FROM users
            WHERE id = ?
        `, [userId]);

        return users.length > 0 && users[0].email_verified === 1;
    }

    /**
     * Send welcome email after verification
     * @private
     */
    async _sendWelcomeEmail(userId, email) {
        try {
            // Get user's model information
            const models = await query(`
                SELECT m.slug, m.name
                FROM models m
                JOIN model_users mu ON m.id = mu.model_id
                WHERE mu.user_id = ? AND mu.role = 'owner'
                LIMIT 1
            `, [userId]);

            if (models.length === 0) {
                console.log(`⚠️  No model found for user ${userId}, skipping welcome email`);
                return;
            }

            const model = models[0];
            const portfolioUrl = `${this.siteUrl}/${model.slug}`;
            const dashboardLink = `${this.siteUrl}/dashboard`;
            const supportLink = `${this.siteUrl}/support`;

            // Get user name
            const users = await query(`
                SELECT email
                FROM users
                WHERE id = ?
            `, [userId]);

            const userName = model.name || users[0].email.split('@')[0];

            // Queue welcome email
            await emailService.queueEmail({
                to: email,
                templateName: 'welcome_email',
                templateData: {
                    siteName: this.siteName,
                    userName: userName,
                    portfolioUrl: portfolioUrl,
                    dashboardLink: dashboardLink,
                    supportLink: supportLink
                },
                emailType: 'welcome',
                userId: userId,
                modelId: models[0].id,
                priority: 5 // Normal priority
            });

            console.log(`📧 Welcome email queued for user ${userId} (${email})`);

        } catch (error) {
            console.error('Failed to send welcome email:', error);
            // Don't throw - welcome email failure shouldn't break verification
        }
    }

    /**
     * Clean up expired verification tokens
     */
    async cleanupExpiredTokens() {
        const result = await query(`
            DELETE FROM email_verifications
            WHERE verified_at IS NULL
              AND expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
        `);

        if (result.affectedRows > 0) {
            console.log(`🧹 Cleaned up ${result.affectedRows} expired verification tokens`);
        }

        return result.affectedRows;
    }

    /**
     * Get verification status for a user
     * @param {number} userId - User ID
     * @returns {Promise<Object>} Verification status
     */
    async getVerificationStatus(userId) {
        const users = await query(`
            SELECT email, email_verified, email_verified_at
            FROM users
            WHERE id = ?
        `, [userId]);

        if (users.length === 0) {
            throw new Error('User not found');
        }

        const user = users[0];

        // Get pending verifications
        const pendingVerifications = await query(`
            SELECT id, created_at, expires_at
            FROM email_verifications
            WHERE user_id = ?
              AND verified_at IS NULL
              AND expires_at > NOW()
            ORDER BY created_at DESC
            LIMIT 1
        `, [userId]);

        return {
            email: user.email,
            verified: user.email_verified === 1,
            verifiedAt: user.email_verified_at,
            hasPendingVerification: pendingVerifications.length > 0,
            pendingVerification: pendingVerifications.length > 0 ? {
                sentAt: pendingVerifications[0].created_at,
                expiresAt: pendingVerifications[0].expires_at
            } : null
        };
    }
}

// Export singleton instance
module.exports = new EmailVerificationService();
