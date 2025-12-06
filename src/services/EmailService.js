/**
 * EmailService - Provider-agnostic email service with queue support
 * Supports: AWS SES, SMTP, SendGrid, Mailgun
 * Phase 1.7 of Authentication & Onboarding Implementation Plan
 */

const AWS = require('aws-sdk');
const nodemailer = require('nodemailer');
const handlebars = require('handlebars');
const { query } = require('../../config/database');

class EmailService {
    constructor() {
        this.provider = process.env.EMAIL_PROVIDER || 'ses'; // ses, smtp, sendgrid, mailgun
        this.fromEmail = process.env.FROM_EMAIL || 'noreply@musenest.com';
        this.fromName = process.env.FROM_NAME || 'MuseNest';

        // Initialize provider
        this._initializeProvider();
    }

    /**
     * Initialize email provider based on environment configuration
     */
    _initializeProvider() {
        switch (this.provider) {
            case 'ses':
                this._initializeSES();
                break;
            case 'smtp':
                this._initializeSMTP();
                break;
            case 'sendgrid':
                this._initializeSendGrid();
                break;
            case 'mailgun':
                this._initializeMailgun();
                break;
            default:
                console.warn(`Unknown email provider: ${this.provider}. Falling back to SMTP.`);
                this._initializeSMTP();
        }
    }

    /**
     * Initialize AWS SES
     */
    _initializeSES() {
        AWS.config.update({
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            region: process.env.AWS_REGION || 'us-east-1'
        });

        this.ses = new AWS.SES({ apiVersion: '2010-12-01' });
        console.log('✅ Email Service: AWS SES initialized');
    }

    /**
     * Initialize SMTP transport
     */
    _initializeSMTP() {
        this.transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'localhost',
            port: parseInt(process.env.SMTP_PORT) || 587,
            secure: process.env.SMTP_SECURE === 'true',
            auth: process.env.SMTP_USER ? {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            } : undefined
        });
        console.log('✅ Email Service: SMTP initialized');
    }

    /**
     * Initialize SendGrid (future implementation)
     */
    _initializeSendGrid() {
        throw new Error('SendGrid provider not yet implemented');
    }

    /**
     * Initialize Mailgun (future implementation)
     */
    _initializeMailgun() {
        throw new Error('Mailgun provider not yet implemented');
    }

    /**
     * Queue an email for sending
     * @param {Object} emailData - Email configuration
     * @param {string} emailData.to - Recipient email address
     * @param {string} emailData.subject - Email subject
     * @param {string} emailData.html - HTML body
     * @param {string} emailData.text - Plain text body
     * @param {string} emailData.templateName - Template name (optional, instead of html/text)
     * @param {Object} emailData.templateData - Template variables (optional)
     * @param {number} emailData.priority - Priority 1-10 (1=highest, default 5)
     * @param {Date} emailData.scheduledFor - Schedule for future sending (optional)
     * @param {string} emailData.emailType - Type of email (verification, password_reset, etc)
     * @param {number} emailData.userId - Associated user ID (optional)
     * @param {number} emailData.modelId - Associated model ID (optional)
     * @param {Object} emailData.metadata - Additional metadata (optional)
     * @returns {Promise<number>} Email queue ID
     */
    async queueEmail(emailData) {
        try {
            const {
                to,
                subject,
                html,
                text,
                templateName,
                templateData,
                priority = 5,
                scheduledFor = null,
                emailType,
                userId = null,
                modelId = null,
                metadata = null,
                replyTo = null
            } = emailData;

            // Validate required fields
            if (!to) {
                throw new Error('Recipient email address is required');
            }

            if (!subject && !templateName) {
                throw new Error('Subject or templateName is required');
            }

            // If using template, fetch and render it
            let finalHtml = html;
            let finalText = text;
            let finalSubject = subject;
            let templateId = null;

            if (templateName) {
                const template = await this._getTemplate(templateName);
                if (!template) {
                    throw new Error(`Email template not found: ${templateName}`);
                }

                templateId = template.id;
                finalSubject = this._renderTemplate(template.subject, templateData || {});
                finalHtml = this._renderTemplate(template.template_html, templateData || {});
                finalText = template.template_text
                    ? this._renderTemplate(template.template_text, templateData || {})
                    : null;
            }

            // Insert into queue
            const result = await query(`
                INSERT INTO email_queue (
                    to_email,
                    from_email,
                    reply_to,
                    subject,
                    html_body,
                    text_body,
                    template_id,
                    template_data,
                    status,
                    priority,
                    scheduled_for,
                    email_type,
                    user_id,
                    model_id,
                    metadata,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, NOW())
            `, [
                to,
                this.fromEmail,
                replyTo || null,
                finalSubject,
                finalHtml,
                finalText,
                templateId,
                templateData ? JSON.stringify(templateData) : null,
                priority,
                scheduledFor,
                emailType,
                userId,
                modelId,
                metadata ? JSON.stringify(metadata) : null
            ]);

            const queueId = result.insertId;

            // Log event
            await this._logEmailEvent(queueId, 'queued', {
                to_email: to,
                priority: priority,
                scheduled_for: scheduledFor
            });

            console.log(`📧 Email queued: ID=${queueId}, Type=${emailType}, To=${to}`);
            return queueId;

        } catch (error) {
            console.error('Failed to queue email:', error);
            throw error;
        }
    }

    /**
     * Send email immediately (bypasses queue)
     * @param {Object} emailData - Same as queueEmail
     * @returns {Promise<Object>} Send result
     */
    async sendImmediate(emailData) {
        try {
            const {
                to,
                subject,
                html,
                text,
                templateName,
                templateData,
                replyTo = null
            } = emailData;

            // Validate required fields
            if (!to) {
                throw new Error('Recipient email address is required');
            }

            // If using template, fetch and render it
            let finalHtml = html;
            let finalText = text;
            let finalSubject = subject;

            if (templateName) {
                const template = await this._getTemplate(templateName);
                if (!template) {
                    throw new Error(`Email template not found: ${templateName}`);
                }

                finalSubject = this._renderTemplate(template.subject, templateData || {});
                finalHtml = this._renderTemplate(template.template_html, templateData || {});
                finalText = template.template_text
                    ? this._renderTemplate(template.template_text, templateData || {})
                    : null;
            }

            if (!finalSubject) {
                throw new Error('Subject is required');
            }

            // Send based on provider
            const sendResult = await this._sendViaProvider({
                to,
                from: this.fromEmail,
                replyTo,
                subject: finalSubject,
                html: finalHtml,
                text: finalText
            });

            console.log(`📧 Email sent immediately: To=${to}, Subject=${finalSubject}`);
            return sendResult;

        } catch (error) {
            console.error('Failed to send email immediately:', error);
            throw error;
        }
    }

    /**
     * Send email via configured provider
     * @private
     */
    async _sendViaProvider({ to, from, replyTo, subject, html, text }) {
        switch (this.provider) {
            case 'ses':
                return await this._sendViaSES({ to, from, replyTo, subject, html, text });
            case 'smtp':
                return await this._sendViaSMTP({ to, from, replyTo, subject, html, text });
            default:
                throw new Error(`Provider ${this.provider} not supported for immediate sending`);
        }
    }

    /**
     * Send email via AWS SES
     * @private
     */
    async _sendViaSES({ to, from, replyTo, subject, html, text }) {
        const params = {
            Source: from,
            Destination: {
                ToAddresses: [to]
            },
            Message: {
                Subject: {
                    Data: subject,
                    Charset: 'UTF-8'
                },
                Body: {}
            }
        };

        if (html) {
            params.Message.Body.Html = {
                Data: html,
                Charset: 'UTF-8'
            };
        }

        if (text) {
            params.Message.Body.Text = {
                Data: text,
                Charset: 'UTF-8'
            };
        }

        if (replyTo) {
            params.ReplyToAddresses = [replyTo];
        }

        const result = await this.ses.sendEmail(params).promise();
        return {
            messageId: result.MessageId,
            provider: 'ses'
        };
    }

    /**
     * Send email via SMTP
     * @private
     */
    async _sendViaSMTP({ to, from, replyTo, subject, html, text }) {
        const mailOptions = {
            from: `${this.fromName} <${from}>`,
            to: to,
            replyTo: replyTo || undefined,
            subject: subject,
            html: html || undefined,
            text: text || undefined
        };

        const result = await this.transporter.sendMail(mailOptions);
        return {
            messageId: result.messageId,
            provider: 'smtp'
        };
    }

    /**
     * Get email template by name
     * @private
     */
    async _getTemplate(templateName) {
        const templates = await query(
            'SELECT * FROM email_templates WHERE template_name = ? AND is_active = true',
            [templateName]
        );
        return templates.length > 0 ? templates[0] : null;
    }

    /**
     * Render template with Handlebars
     * @private
     */
    _renderTemplate(templateString, data) {
        try {
            const template = handlebars.compile(templateString);
            return template(data);
        } catch (error) {
            console.error('Template rendering error:', error);
            return templateString; // Return unrendered template on error
        }
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
            // Don't throw - logging failure shouldn't break email sending
        }
    }

    /**
     * Get email templates (for admin UI)
     */
    async getTemplates(category = null) {
        let sql = 'SELECT * FROM email_templates WHERE is_active = true';
        const params = [];

        if (category) {
            sql += ' AND template_category = ?';
            params.push(category);
        }

        sql += ' ORDER BY template_category, template_name';
        return await query(sql, params);
    }

    /**
     * Create or update email template
     */
    async saveTemplate(templateData) {
        const {
            id,
            templateName,
            templateCategory,
            subject,
            templateHtml,
            templateText,
            variables,
            isActive = true
        } = templateData;

        if (id) {
            // Update existing template
            await query(`
                UPDATE email_templates
                SET template_category = ?,
                    subject = ?,
                    template_html = ?,
                    template_text = ?,
                    variables = ?,
                    is_active = ?,
                    updated_at = NOW()
                WHERE id = ?
            `, [templateCategory, subject, templateHtml, templateText, JSON.stringify(variables), isActive, id]);
            return id;
        } else {
            // Create new template
            const result = await query(`
                INSERT INTO email_templates (
                    template_name, template_category, subject, template_html,
                    template_text, variables, is_active, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
            `, [templateName, templateCategory, subject, templateHtml, templateText, JSON.stringify(variables), isActive]);
            return result.insertId;
        }
    }
}

// Export singleton instance
module.exports = new EmailService();
