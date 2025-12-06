-- Migration: 106_email_infrastructure.sql
-- Email service infrastructure with queue, templates, and delivery tracking
-- Phase 1.7 of Authentication & Onboarding Implementation Plan

-- Email templates table for reusable email content
CREATE TABLE IF NOT EXISTS email_templates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    template_name VARCHAR(100) UNIQUE NOT NULL,
    template_category ENUM('auth', 'onboarding', 'billing', 'notification', 'marketing', 'system') NOT NULL,
    subject VARCHAR(255) NOT NULL,
    template_html TEXT NOT NULL,
    template_text TEXT,
    variables JSON COMMENT 'List of required variables for template',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_template_name (template_name),
    INDEX idx_template_category (template_category),
    INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Reusable email templates with Handlebars-style variable substitution';

-- Email queue table with retry logic
CREATE TABLE IF NOT EXISTS email_queue (
    id INT AUTO_INCREMENT PRIMARY KEY,
    to_email VARCHAR(255) NOT NULL,
    from_email VARCHAR(255) NOT NULL,
    reply_to VARCHAR(255),
    subject VARCHAR(255) NOT NULL,
    html_body TEXT,
    text_body TEXT,
    template_id INT NULL,
    template_data JSON,

    -- Queue management
    status ENUM('pending', 'processing', 'sent', 'failed', 'cancelled') DEFAULT 'pending',
    priority TINYINT DEFAULT 5 COMMENT '1=highest, 10=lowest',
    scheduled_for TIMESTAMP NULL COMMENT 'Null = send immediately',

    -- Retry logic
    retry_count INT DEFAULT 0,
    max_retries INT DEFAULT 3,
    last_retry_at TIMESTAMP NULL,
    next_retry_at TIMESTAMP NULL,

    -- Delivery tracking
    sent_at TIMESTAMP NULL,
    provider_response JSON COMMENT 'Response from email provider (SES, SendGrid, etc)',
    error_message TEXT,

    -- Metadata
    user_id INT NULL COMMENT 'Associated user if applicable',
    model_id INT NULL COMMENT 'Associated model if applicable',
    email_type VARCHAR(50) COMMENT 'verification, password_reset, onboarding, etc',
    metadata JSON COMMENT 'Additional context data',

    -- Audit
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_status (status),
    INDEX idx_to_email (to_email),
    INDEX idx_scheduled_for (scheduled_for),
    INDEX idx_next_retry_at (next_retry_at),
    INDEX idx_email_type (email_type),
    INDEX idx_user_id (user_id),
    INDEX idx_model_id (model_id),
    INDEX idx_created_at (created_at),
    INDEX idx_priority_status (priority, status),

    FOREIGN KEY (template_id) REFERENCES email_templates(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Email queue with retry logic and exponential backoff support';

-- Email delivery log table (for analytics and debugging)
CREATE TABLE IF NOT EXISTS email_delivery_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email_queue_id INT NOT NULL,
    event_type ENUM('queued', 'processing', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'failed') NOT NULL,
    event_data JSON,
    provider_message_id VARCHAR(255) COMMENT 'Message ID from email provider',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_email_queue_id (email_queue_id),
    INDEX idx_event_type (event_type),
    INDEX idx_provider_message_id (provider_message_id),
    INDEX idx_created_at (created_at),

    FOREIGN KEY (email_queue_id) REFERENCES email_queue(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Detailed log of email delivery events for analytics and debugging';

-- Insert default email templates
INSERT IGNORE INTO email_templates (template_name, template_category, subject, template_html, template_text, variables) VALUES

-- Email verification template
('email_verification', 'auth', 'Verify Your Email Address',
'<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
    <h1 style="color: #333;">Welcome to {{siteName}}!</h1>
    <p>Thank you for registering. Please verify your email address to complete your account setup.</p>
    <div style="margin: 30px 0;">
        <a href="{{verificationLink}}" style="background-color: #007bff; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block;">Verify Email Address</a>
    </div>
    <p style="color: #666; font-size: 14px;">Or copy this link into your browser:</p>
    <p style="color: #007bff; font-size: 14px; word-break: break-all;">{{verificationLink}}</p>
    <p style="color: #666; font-size: 12px; margin-top: 30px;">This link will expire in {{expiryHours}} hours.</p>
    <p style="color: #666; font-size: 12px;">If you didn\'t create an account, please ignore this email.</p>
</body>
</html>',
'Welcome to {{siteName}}!

Thank you for registering. Please verify your email address by clicking the link below:

{{verificationLink}}

This link will expire in {{expiryHours}} hours.

If you didn\'t create an account, please ignore this email.',
'["siteName", "verificationLink", "expiryHours"]'),

-- Password reset template
('password_reset', 'auth', 'Reset Your Password',
'<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
    <h1 style="color: #333;">Password Reset Request</h1>
    <p>We received a request to reset your password for your {{siteName}} account.</p>
    <div style="margin: 30px 0;">
        <a href="{{resetLink}}" style="background-color: #dc3545; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block;">Reset Password</a>
    </div>
    <p style="color: #666; font-size: 14px;">Or copy this link into your browser:</p>
    <p style="color: #dc3545; font-size: 14px; word-break: break-all;">{{resetLink}}</p>
    <p style="color: #666; font-size: 12px; margin-top: 30px;">This link will expire in {{expiryMinutes}} minutes.</p>
    <p style="color: #dc3545; font-size: 12px; font-weight: bold;">If you didn\'t request a password reset, please ignore this email and ensure your account is secure.</p>
</body>
</html>',
'Password Reset Request

We received a request to reset your password for your {{siteName}} account.

Click the link below to reset your password:

{{resetLink}}

This link will expire in {{expiryMinutes}} minutes.

If you didn\'t request a password reset, please ignore this email and ensure your account is secure.',
'["siteName", "resetLink", "expiryMinutes"]'),

-- Welcome email template
('welcome_email', 'onboarding', 'Welcome to {{siteName}}!',
'<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
    <h1 style="color: #333;">Welcome aboard, {{userName}}!</h1>
    <p>Your email has been verified and your account is now active.</p>
    <h2 style="color: #555; font-size: 18px; margin-top: 30px;">Next Steps:</h2>
    <ul style="line-height: 2;">
        <li>Complete your profile setup</li>
        <li>Upload your first photos</li>
        <li>Customize your portfolio theme</li>
        <li>Share your unique URL: <strong>{{portfolioUrl}}</strong></li>
    </ul>
    <div style="margin: 30px 0;">
        <a href="{{dashboardLink}}" style="background-color: #28a745; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; display: inline-block;">Go to Dashboard</a>
    </div>
    <p style="color: #666; font-size: 12px; margin-top: 30px;">Need help? Reply to this email or visit our <a href="{{supportLink}}">support center</a>.</p>
</body>
</html>',
'Welcome aboard, {{userName}}!

Your email has been verified and your account is now active.

Next Steps:
- Complete your profile setup
- Upload your first photos
- Customize your portfolio theme
- Share your unique URL: {{portfolioUrl}}

Go to your dashboard: {{dashboardLink}}

Need help? Reply to this email or visit our support center: {{supportLink}}',
'["siteName", "userName", "portfolioUrl", "dashboardLink", "supportLink"]');

-- Create indexes for efficient queue processing
CREATE INDEX idx_pending_emails ON email_queue(status, priority, scheduled_for, next_retry_at);

-- Add comment for documentation
ALTER TABLE email_templates COMMENT = 'Email templates using Handlebars syntax for variable substitution. Variables are stored as JSON array.';
ALTER TABLE email_queue COMMENT = 'Email queue with retry logic. Priority 1-10 (1=highest). Supports scheduled sending and exponential backoff.';
ALTER TABLE email_delivery_log COMMENT = 'Detailed event log for email tracking. Integrates with provider webhooks (SES SNS, SendGrid, etc).';
