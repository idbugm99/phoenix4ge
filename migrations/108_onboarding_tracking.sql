-- Migration: 108_onboarding_tracking.sql
-- Add onboarding progress tracking system
-- Phase 1.9 of Authentication & Onboarding Implementation Plan
-- Track user onboarding journey and completion

-- Create onboarding progress table
CREATE TABLE IF NOT EXISTS onboarding_progress (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL UNIQUE,

    -- Progress tracking
    current_step VARCHAR(50) COMMENT 'Current onboarding step',
    completed_steps JSON COMMENT 'Array of completed step names',
    skipped_steps JSON COMMENT 'Array of skipped step names',

    -- Completion status
    onboarding_completed BOOLEAN DEFAULT FALSE,
    completion_percentage INT DEFAULT 0 COMMENT '0-100',

    -- Step timestamps
    email_verified_at TIMESTAMP NULL,
    profile_completed_at TIMESTAMP NULL,
    first_content_uploaded_at TIMESTAMP NULL,
    payment_method_added_at TIMESTAMP NULL,
    mfa_enabled_at TIMESTAMP NULL,

    -- Journey tracking
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    abandoned_at TIMESTAMP NULL COMMENT 'User stopped onboarding',

    -- Engagement metrics
    total_logins INT DEFAULT 0,
    days_since_signup INT DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_user_id (user_id),
    INDEX idx_completed (onboarding_completed),
    INDEX idx_completion_percentage (completion_percentage),
    INDEX idx_current_step (current_step),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'User onboarding progress tracking. Tracks completion of key onboarding steps.';

-- Create onboarding steps definition table
CREATE TABLE IF NOT EXISTS onboarding_steps (
    id INT AUTO_INCREMENT PRIMARY KEY,

    -- Step definition
    step_key VARCHAR(50) NOT NULL UNIQUE COMMENT 'email_verification, profile_setup, etc',
    step_name VARCHAR(100) NOT NULL,
    step_description TEXT,
    step_order INT NOT NULL COMMENT 'Display order',

    -- Step properties
    required BOOLEAN DEFAULT TRUE COMMENT 'Required for completion',
    weight INT DEFAULT 10 COMMENT 'Weight in completion percentage',

    -- Help/guidance
    help_text TEXT,
    help_url VARCHAR(500),

    -- Status
    enabled BOOLEAN DEFAULT TRUE,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_step_key (step_key),
    INDEX idx_enabled (enabled),
    INDEX idx_step_order (step_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Onboarding step definitions. Configurable steps for user onboarding.';

-- Create onboarding events table (for analytics)
CREATE TABLE IF NOT EXISTS onboarding_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,

    -- Event details
    event_type VARCHAR(50) NOT NULL COMMENT 'step_started, step_completed, step_skipped',
    step_key VARCHAR(50),

    -- Event context
    ip_address VARCHAR(45),
    user_agent TEXT,
    metadata JSON,

    -- Timestamp
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_user_id (user_id),
    INDEX idx_event_type (event_type),
    INDEX idx_step_key (step_key),
    INDEX idx_created_at (created_at),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Onboarding events for analytics. Track user journey through onboarding.';

-- Insert default onboarding steps
INSERT INTO onboarding_steps (step_key, step_name, step_description, step_order, required, weight, help_text) VALUES
('email_verification', 'Verify Email', 'Verify your email address to secure your account', 1, TRUE, 15, 'Check your inbox for the verification email'),
('profile_setup', 'Complete Profile', 'Add your name and profile information', 2, TRUE, 10, 'Tell us about yourself'),
('first_content', 'Upload Content', 'Upload your first photo or video', 3, TRUE, 25, 'Share your content with the world'),
('payment_setup', 'Add Payment Method', 'Add a payment method for subscriptions', 4, FALSE, 20, 'Required for paid features'),
('mfa_setup', 'Enable Two-Factor Auth', 'Secure your account with 2FA', 5, FALSE, 15, 'Protect your account with an extra layer of security'),
('oauth_link', 'Link Social Accounts', 'Connect with Google or Facebook', 6, FALSE, 10, 'Sign in faster with social login'),
('welcome_tour', 'Take Welcome Tour', 'Learn how to use the platform', 7, FALSE, 5, 'Get familiar with key features');

-- Add onboarding columns to users table
SET @col_exists_onboarding_completed = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'onboarding_completed');

SET @sql_onboarding = IF(@col_exists_onboarding_completed = 0,
    'ALTER TABLE users ADD COLUMN onboarding_completed BOOLEAN DEFAULT FALSE COMMENT ''Onboarding finished'' AFTER oauth_primary_provider',
    'SELECT "onboarding_completed column already exists" AS message');
PREPARE stmt FROM @sql_onboarding;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists_onboarding_completed_at = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'onboarding_completed_at');

SET @sql_onboarding_at = IF(@col_exists_onboarding_completed_at = 0,
    'ALTER TABLE users ADD COLUMN onboarding_completed_at TIMESTAMP NULL AFTER onboarding_completed',
    'SELECT "onboarding_completed_at column already exists" AS message');
PREPARE stmt FROM @sql_onboarding_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Add comments
ALTER TABLE onboarding_progress
COMMENT = 'User onboarding progress. Tracks completion of required and optional steps for user activation.';

ALTER TABLE onboarding_steps
COMMENT = 'Onboarding step definitions. Admin-configurable steps with weights for completion calculation.';

ALTER TABLE onboarding_events
COMMENT = 'Onboarding analytics events. Track user behavior during onboarding for funnel analysis.';
