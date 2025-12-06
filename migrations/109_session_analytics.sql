-- Migration: 109_session_analytics.sql
-- Add session analytics and user behavior tracking
-- Phase 1.10 of Authentication & Onboarding Implementation Plan
-- Track user sessions, activity patterns, and engagement metrics

-- Create user sessions table (comprehensive session tracking)
CREATE TABLE IF NOT EXISTS user_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,

    -- Session identification
    session_token VARCHAR(64) NOT NULL UNIQUE COMMENT 'SHA-256 hash of session ID',
    refresh_token_id INT NULL COMMENT 'Linked refresh token',

    -- Session details
    ip_address VARCHAR(45),
    user_agent TEXT,
    device_type VARCHAR(20) COMMENT 'desktop, mobile, tablet',
    browser VARCHAR(50),
    os VARCHAR(50),
    country VARCHAR(2) COMMENT 'ISO country code',
    city VARCHAR(100),

    -- Session lifecycle
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    ended_at TIMESTAMP NULL,

    -- Session metadata
    duration_seconds INT DEFAULT 0 COMMENT 'Total session duration',
    page_views INT DEFAULT 0,
    actions_count INT DEFAULT 0,

    -- Session status
    is_active BOOLEAN DEFAULT TRUE,
    ended_reason VARCHAR(50) COMMENT 'logout, timeout, token_revoked, expired',

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_user_id (user_id),
    INDEX idx_session_token (session_token),
    INDEX idx_started_at (started_at),
    INDEX idx_is_active (is_active),
    INDEX idx_refresh_token_id (refresh_token_id),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (refresh_token_id) REFERENCES refresh_tokens(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'User session tracking. Comprehensive session analytics with device and location info.';

-- Create user activity log table (detailed action tracking)
CREATE TABLE IF NOT EXISTS user_activity_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    session_id INT NULL,

    -- Activity details
    activity_type VARCHAR(50) NOT NULL COMMENT 'page_view, api_call, upload, download, etc',
    activity_category VARCHAR(50) COMMENT 'navigation, content, settings, billing',

    -- Request details
    endpoint VARCHAR(255) COMMENT 'API endpoint or page URL',
    http_method VARCHAR(10) COMMENT 'GET, POST, PUT, DELETE',

    -- Context
    ip_address VARCHAR(45),
    user_agent TEXT,

    -- Metadata
    metadata JSON COMMENT 'Activity-specific data',

    -- Performance
    response_time_ms INT COMMENT 'Response time in milliseconds',
    status_code INT COMMENT 'HTTP status code',

    -- Timestamp
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_user_id (user_id),
    INDEX idx_session_id (session_id),
    INDEX idx_activity_type (activity_type),
    INDEX idx_activity_category (activity_category),
    INDEX idx_created_at (created_at),
    INDEX idx_user_created (user_id, created_at),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES user_sessions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'User activity log. Detailed tracking of user actions and API calls.';

-- Create user engagement metrics table (aggregated daily stats)
CREATE TABLE IF NOT EXISTS user_engagement_metrics (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    date DATE NOT NULL,

    -- Session metrics
    sessions_count INT DEFAULT 0,
    total_session_duration_seconds INT DEFAULT 0,
    avg_session_duration_seconds INT DEFAULT 0,

    -- Activity metrics
    page_views INT DEFAULT 0,
    api_calls INT DEFAULT 0,
    actions_count INT DEFAULT 0,

    -- Engagement indicators
    uploads_count INT DEFAULT 0,
    downloads_count INT DEFAULT 0,
    profile_updates INT DEFAULT 0,
    settings_changes INT DEFAULT 0,

    -- Device usage
    desktop_sessions INT DEFAULT 0,
    mobile_sessions INT DEFAULT 0,
    tablet_sessions INT DEFAULT 0,

    -- Timing
    first_activity_at TIMESTAMP NULL,
    last_activity_at TIMESTAMP NULL,

    -- Engagement score (0-100)
    engagement_score INT DEFAULT 0 COMMENT 'Calculated engagement score',

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Indexes
    UNIQUE KEY unique_user_date (user_id, date),
    INDEX idx_user_id (user_id),
    INDEX idx_date (date),
    INDEX idx_engagement_score (engagement_score),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Daily user engagement metrics. Aggregated stats for analytics dashboards.';

-- Create analytics events table (business intelligence events)
CREATE TABLE IF NOT EXISTS analytics_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    -- Event identification
    event_name VARCHAR(100) NOT NULL COMMENT 'signup_completed, payment_made, content_uploaded',
    event_category VARCHAR(50) COMMENT 'authentication, onboarding, billing, content',

    -- User context
    user_id INT NULL COMMENT 'Null for anonymous events',
    session_id INT NULL,

    -- Event properties
    properties JSON COMMENT 'Event-specific properties',

    -- Context
    ip_address VARCHAR(45),
    user_agent TEXT,
    referrer VARCHAR(500),

    -- UTM tracking
    utm_source VARCHAR(100),
    utm_medium VARCHAR(100),
    utm_campaign VARCHAR(100),
    utm_term VARCHAR(100),
    utm_content VARCHAR(100),

    -- Timestamp
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_event_name (event_name),
    INDEX idx_event_category (event_category),
    INDEX idx_user_id (user_id),
    INDEX idx_session_id (session_id),
    INDEX idx_created_at (created_at),
    INDEX idx_name_created (event_name, created_at),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (session_id) REFERENCES user_sessions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Analytics events for business intelligence. Track key user actions and conversions.';

-- Create user cohorts table (cohort analysis)
CREATE TABLE IF NOT EXISTS user_cohorts (
    id INT AUTO_INCREMENT PRIMARY KEY,

    -- Cohort definition
    cohort_name VARCHAR(100) NOT NULL UNIQUE,
    cohort_description TEXT,
    cohort_type VARCHAR(50) COMMENT 'signup_date, subscription_tier, referral_source',

    -- Cohort criteria
    criteria JSON COMMENT 'Criteria for cohort membership',

    -- Statistics
    user_count INT DEFAULT 0,

    -- Status
    is_active BOOLEAN DEFAULT TRUE,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_cohort_name (cohort_name),
    INDEX idx_cohort_type (cohort_type),
    INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'User cohorts for cohort analysis. Group users by signup date, subscription, etc.';

-- Create cohort membership table
CREATE TABLE IF NOT EXISTS cohort_memberships (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cohort_id INT NOT NULL,
    user_id INT NOT NULL,

    -- Membership details
    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes
    UNIQUE KEY unique_cohort_user (cohort_id, user_id),
    INDEX idx_cohort_id (cohort_id),
    INDEX idx_user_id (user_id),

    FOREIGN KEY (cohort_id) REFERENCES user_cohorts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Cohort membership. Many-to-many relationship between users and cohorts.';

-- Create funnel tracking table (conversion funnels)
CREATE TABLE IF NOT EXISTS funnel_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    -- Funnel identification
    funnel_name VARCHAR(100) NOT NULL COMMENT 'signup_funnel, onboarding_funnel, payment_funnel',
    funnel_step VARCHAR(100) NOT NULL COMMENT 'Step name in funnel',
    step_order INT NOT NULL,

    -- User context
    user_id INT NULL,
    session_id INT NULL,

    -- Event details
    event_type VARCHAR(50) NOT NULL COMMENT 'step_started, step_completed, step_abandoned',

    -- Context
    ip_address VARCHAR(45),
    metadata JSON,

    -- Timestamp
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_funnel_name (funnel_name),
    INDEX idx_funnel_step (funnel_step),
    INDEX idx_user_id (user_id),
    INDEX idx_session_id (session_id),
    INDEX idx_created_at (created_at),
    INDEX idx_funnel_user (funnel_name, user_id),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (session_id) REFERENCES user_sessions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Funnel event tracking. Track user progression through conversion funnels.';

-- Add analytics columns to users table
SET @col_exists_first_session_at = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'first_session_at');

SET @sql_first_session = IF(@col_exists_first_session_at = 0,
    'ALTER TABLE users ADD COLUMN first_session_at TIMESTAMP NULL COMMENT ''First session timestamp'' AFTER onboarding_completed_at',
    'SELECT "first_session_at column already exists" AS message');
PREPARE stmt FROM @sql_first_session;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists_last_session_at = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'last_session_at');

SET @sql_last_session = IF(@col_exists_last_session_at = 0,
    'ALTER TABLE users ADD COLUMN last_session_at TIMESTAMP NULL AFTER first_session_at',
    'SELECT "last_session_at column already exists" AS message');
PREPARE stmt FROM @sql_last_session;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists_total_sessions = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'total_sessions');

SET @sql_total_sessions = IF(@col_exists_total_sessions = 0,
    'ALTER TABLE users ADD COLUMN total_sessions INT DEFAULT 0 COMMENT ''Total session count'' AFTER last_session_at',
    'SELECT "total_sessions column already exists" AS message');
PREPARE stmt FROM @sql_total_sessions;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col_exists_lifetime_engagement_score = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'lifetime_engagement_score');

SET @sql_engagement_score = IF(@col_exists_lifetime_engagement_score = 0,
    'ALTER TABLE users ADD COLUMN lifetime_engagement_score INT DEFAULT 0 COMMENT ''Lifetime engagement score (0-100)'' AFTER total_sessions',
    'SELECT "lifetime_engagement_score column already exists" AS message');
PREPARE stmt FROM @sql_engagement_score;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Insert default cohorts
INSERT IGNORE INTO user_cohorts (cohort_name, cohort_description, cohort_type, criteria) VALUES
('week_1_signups', 'Users who signed up in week 1', 'signup_date', '{"period": "week_1"}'),
('oauth_users', 'Users who signed up via OAuth', 'signup_method', '{"method": "oauth"}'),
('email_users', 'Users who signed up via email', 'signup_method', '{"method": "email"}'),
('mfa_enabled_users', 'Users with MFA enabled', 'security', '{"mfa_enabled": true}'),
('onboarding_completed', 'Users who completed onboarding', 'onboarding', '{"completed": true}'),
('high_engagement', 'Users with high engagement (80+ score)', 'engagement', '{"min_score": 80}');

-- Add comments for documentation
ALTER TABLE user_sessions
COMMENT = 'User session tracking. Tracks active and historical sessions with device info.';

ALTER TABLE user_activity_log
COMMENT = 'Detailed activity log. Every user action is logged for analytics and debugging.';

ALTER TABLE user_engagement_metrics
COMMENT = 'Daily engagement metrics. Aggregated statistics for dashboard and reporting.';

ALTER TABLE analytics_events
COMMENT = 'Business intelligence events. Key conversion events with UTM tracking.';

ALTER TABLE user_cohorts
COMMENT = 'User cohorts definition. Define groups for cohort analysis and A/B testing.';

ALTER TABLE funnel_events
COMMENT = 'Conversion funnel tracking. Track user progression through multi-step flows.';
