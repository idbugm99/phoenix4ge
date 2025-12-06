/**
 * EmailQueueProcessor - Background processor for email queue
 * Handles retry logic with exponential backoff
 * Phase 1.7 of Authentication & Onboarding Implementation Plan
 */

const emailService = require('./EmailService');
const { query } = require('../../config/database');

class EmailQueueProcessor {
    constructor() {
        this.isProcessing = false;
        this.processInterval = null;
        this.intervalMs = parseInt(process.env.EMAIL_QUEUE_INTERVAL) || 30000; // 30 seconds default
        this.batchSize = parseInt(process.env.EMAIL_QUEUE_BATCH_SIZE) || 10;
        this.maxRetries = parseInt(process.env.EMAIL_MAX_RETRIES) || 3;
    }

    /**
     * Start the email queue processor
     */
    start() {
        if (this.processInterval) {
            console.log('⚠️  Email queue processor already running');
            return;
        }

        console.log(`📧 Starting email queue processor (interval: ${this.intervalMs}ms, batch: ${this.batchSize})`);

        // Process immediately, then on interval
        this.processQueue();
        this.processInterval = setInterval(() => this.processQueue(), this.intervalMs);
    }

    /**
     * Stop the email queue processor
     */
    stop() {
        if (this.processInterval) {
            clearInterval(this.processInterval);
            this.processInterval = null;
            console.log('📧 Email queue processor stopped');
        }
    }

    /**
     * Process emails in the queue
     */
    async processQueue() {
        if (this.isProcessing) {
            console.log('📧 Queue processor already running, skipping this cycle');
            return;
        }

        this.isProcessing = true;

        try {
            // Get pending emails (ready to send)
            const emails = await this._getPendingEmails();

            if (emails.length === 0) {
                // console.log('📧 No pending emails in queue');
                return;
            }

            console.log(`📧 Processing ${emails.length} emails from queue`);

            // Process each email
            for (const email of emails) {
                await this._processEmail(email);
            }

        } catch (error) {
            console.error('Email queue processing error:', error);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Get pending emails from queue
     * @private
     */
    async _getPendingEmails() {
        // Get emails that are:
        // 1. Status = 'pending'
        // 2. Either not scheduled OR scheduled_for <= NOW()
        // 3. Either never retried OR next_retry_at <= NOW()
        // 4. retry_count < max_retries

        const emails = await query(`
            SELECT *
            FROM email_queue
            WHERE status = 'pending'
              AND (scheduled_for IS NULL OR scheduled_for <= NOW())
              AND (next_retry_at IS NULL OR next_retry_at <= NOW())
              AND retry_count < max_retries
            ORDER BY priority ASC, created_at ASC
            LIMIT ?
        `, [this.batchSize]);

        return emails;
    }

    /**
     * Process a single email
     * @private
     */
    async _processEmail(email) {
        try {
            // Mark as processing
            await this._updateEmailStatus(email.id, 'processing');

            // Log event
            await this._logEmailEvent(email.id, 'processing', {
                retry_count: email.retry_count,
                attempt: email.retry_count + 1
            });

            // Send email
            const sendResult = await emailService._sendViaProvider({
                to: email.to_email,
                from: email.from_email,
                replyTo: email.reply_to,
                subject: email.subject,
                html: email.html_body,
                text: email.text_body
            });

            // Mark as sent
            await query(`
                UPDATE email_queue
                SET status = 'sent',
                    sent_at = NOW(),
                    provider_response = ?,
                    updated_at = NOW()
                WHERE id = ?
            `, [JSON.stringify(sendResult), email.id]);

            // Log success
            await this._logEmailEvent(email.id, 'sent', {
                message_id: sendResult.messageId,
                provider: sendResult.provider
            });

            console.log(`✅ Email sent successfully: ID=${email.id}, To=${email.to_email}`);

        } catch (error) {
            console.error(`❌ Failed to send email ID=${email.id}:`, error.message);

            // Calculate next retry time with exponential backoff
            const nextRetryAt = this._calculateNextRetry(email.retry_count + 1);

            // Check if we should retry
            if (email.retry_count + 1 < email.max_retries) {
                // Schedule retry
                await query(`
                    UPDATE email_queue
                    SET status = 'pending',
                        retry_count = retry_count + 1,
                        last_retry_at = NOW(),
                        next_retry_at = ?,
                        error_message = ?,
                        updated_at = NOW()
                    WHERE id = ?
                `, [nextRetryAt, error.message, email.id]);

                await this._logEmailEvent(email.id, 'failed', {
                    error: error.message,
                    retry_count: email.retry_count + 1,
                    next_retry_at: nextRetryAt
                });

                console.log(`🔄 Email ID=${email.id} scheduled for retry at ${nextRetryAt}`);
            } else {
                // Max retries reached, mark as failed
                await query(`
                    UPDATE email_queue
                    SET status = 'failed',
                        error_message = ?,
                        updated_at = NOW()
                    WHERE id = ?
                `, [error.message, email.id]);

                await this._logEmailEvent(email.id, 'failed', {
                    error: error.message,
                    retry_count: email.retry_count + 1,
                    max_retries_reached: true
                });

                console.log(`❌ Email ID=${email.id} failed permanently after ${email.retry_count + 1} attempts`);
            }
        }
    }

    /**
     * Calculate next retry time with exponential backoff
     * @private
     */
    _calculateNextRetry(retryCount) {
        // Exponential backoff: 2^retryCount minutes
        // Attempt 1: 2 minutes
        // Attempt 2: 4 minutes
        // Attempt 3: 8 minutes
        const delayMinutes = Math.pow(2, retryCount);
        const nextRetry = new Date();
        nextRetry.setMinutes(nextRetry.getMinutes() + delayMinutes);
        return nextRetry;
    }

    /**
     * Update email status
     * @private
     */
    async _updateEmailStatus(emailId, status) {
        await query(`
            UPDATE email_queue
            SET status = ?,
                updated_at = NOW()
            WHERE id = ?
        `, [status, emailId]);
    }

    /**
     * Log email event
     * @private
     */
    async _logEmailEvent(emailQueueId, eventType, eventData) {
        try {
            await query(`
                INSERT INTO email_delivery_log (email_queue_id, event_type, event_data, created_at)
                VALUES (?, ?, ?, NOW())
            `, [emailQueueId, eventType, JSON.stringify(eventData)]);
        } catch (error) {
            console.error('Failed to log email event:', error);
            // Don't throw - logging failure shouldn't break email processing
        }
    }

    /**
     * Get queue statistics
     */
    async getQueueStats() {
        const stats = await query(`
            SELECT
                status,
                COUNT(*) as count,
                AVG(retry_count) as avg_retries
            FROM email_queue
            GROUP BY status
        `);

        const pending = await query(`
            SELECT COUNT(*) as count
            FROM email_queue
            WHERE status = 'pending'
              AND (scheduled_for IS NULL OR scheduled_for <= NOW())
              AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        `);

        return {
            by_status: stats,
            ready_to_send: pending[0].count,
            processor_running: !!this.processInterval,
            interval_ms: this.intervalMs,
            batch_size: this.batchSize
        };
    }

    /**
     * Cancel a queued email
     */
    async cancelEmail(emailId) {
        await query(`
            UPDATE email_queue
            SET status = 'cancelled',
                updated_at = NOW()
            WHERE id = ?
              AND status IN ('pending', 'processing')
        `, [emailId]);

        await this._logEmailEvent(emailId, 'cancelled', {
            cancelled_at: new Date()
        });
    }

    /**
     * Retry a failed email
     */
    async retryEmail(emailId) {
        await query(`
            UPDATE email_queue
            SET status = 'pending',
                retry_count = 0,
                next_retry_at = NULL,
                error_message = NULL,
                updated_at = NOW()
            WHERE id = ?
        `, [emailId]);

        await this._logEmailEvent(emailId, 'queued', {
            manual_retry: true
        });

        console.log(`🔄 Email ID=${emailId} manually queued for retry`);
    }

    /**
     * Cleanup old emails (optional maintenance task)
     */
    async cleanupOldEmails(daysOld = 90) {
        const result = await query(`
            DELETE FROM email_queue
            WHERE status IN ('sent', 'failed', 'cancelled')
              AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
        `, [daysOld]);

        console.log(`🧹 Cleaned up ${result.affectedRows} old emails (${daysOld}+ days)`);
        return result.affectedRows;
    }
}

// Export singleton instance
module.exports = new EmailQueueProcessor();
