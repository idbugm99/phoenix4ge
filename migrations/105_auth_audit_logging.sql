-- Migration: 105_auth_audit_logging.sql
-- Add comprehensive authentication audit logging system
-- Phase 1.6 of Authentication & Onboarding Implementation Plan
-- GDPR-compliant with 90-day retention policy

-- Create authentication audit log table
CREATE TABLE IF NOT EXISTS auth_audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,

    -- Event identification
    event_type VARCHAR(50) NOT NULL COMMENT 'login, logout, register, password_change, password_reset, token_refresh, mfa_enabled, oauth_linked, etc',
    event_category ENUM('authentication', 'authorization', 'account_management', 'security', 'session') NOT NULL,

    -- User identification
    user_id INT NULL,
    email VARCHAR(255),
    username VARCHAR(100),

    -- Event status
    success BOOLEAN NOT NULL,
    failure_reason VARCHAR(255) COMMENT 'Error message or reason for failure',

    -- Request context
    ip_address VARCHAR(45),
    user_agent TEXT,
    request_id VARCHAR(100) COMMENT 'For correlation with application logs',

    -- Security context
    risk_score INT DEFAULT 0 COMMENT '0-100, calculated based on various factors',
    risk_factors JSON COMMENT 'Array of risk indicators: unusual_location, unusual_time, new_device, etc',

    -- Additional metadata
    metadata JSON COMMENT 'Flexible storage for event-specific data',

    -- Location data (optional enhancement)
    country_code VARCHAR(2),
    city VARCHAR(100),

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Indexes for performance
    INDEX idx_user_id (user_id),
    INDEX idx_email (email),
    INDEX idx_event_type (event_type),
    INDEX idx_event_category (event_category),
    INDEX idx_success (success),
    INDEX idx_created_at (created_at),
    INDEX idx_ip_address (ip_address),
    INDEX idx_risk_score (risk_score),
    INDEX idx_user_time (user_id, created_at),
    INDEX idx_user_event (user_id, event_type, created_at),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Comprehensive authentication audit log. GDPR-compliant with 90-day retention. Risk-scored for anomaly detection.';

-- Create audit log summary table (for efficient dashboards)
CREATE TABLE IF NOT EXISTS auth_audit_summary (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,

    -- Daily counters
    date DATE NOT NULL,
    successful_logins INT DEFAULT 0,
    failed_logins INT DEFAULT 0,
    password_changes INT DEFAULT 0,
    token_refreshes INT DEFAULT 0,

    -- Risk indicators
    high_risk_events INT DEFAULT 0,
    unique_ip_addresses INT DEFAULT 0,
    unique_devices INT DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY unique_user_date (user_id, date),
    INDEX idx_user_id (user_id),
    INDEX idx_date (date),
    INDEX idx_high_risk (high_risk_events),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Daily summary of authentication events per user for efficient dashboard queries.';

-- Create suspicious activity alerts table
CREATE TABLE IF NOT EXISTS auth_suspicious_activity (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,

    -- Alert details
    alert_type VARCHAR(50) NOT NULL COMMENT 'impossible_travel, unusual_hours, new_device, multiple_failures, etc',
    severity ENUM('low', 'medium', 'high', 'critical') NOT NULL,
    description TEXT,

    -- Context
    triggering_event_id BIGINT COMMENT 'Reference to auth_audit_log entry',
    ip_address VARCHAR(45),
    metadata JSON,

    -- Status
    status ENUM('new', 'investigating', 'resolved', 'false_positive') DEFAULT 'new',
    resolved_at TIMESTAMP NULL,
    resolved_by INT NULL COMMENT 'Admin user who resolved',
    resolution_notes TEXT,

    -- Timestamps
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_user_id (user_id),
    INDEX idx_alert_type (alert_type),
    INDEX idx_severity (severity),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at),

    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (triggering_event_id) REFERENCES auth_audit_log(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT = 'Suspicious authentication activity alerts for security monitoring.';

-- Add last audit event tracking to users table
SET @col_exists_last_audit = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'last_audit_event_at');

SET @sql_last_audit = IF(@col_exists_last_audit = 0,
    'ALTER TABLE users ADD COLUMN last_audit_event_at TIMESTAMP NULL AFTER last_failed_login_at',
    'SELECT "last_audit_event_at column already exists" AS message');
PREPARE stmt FROM @sql_last_audit;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Create partitioning for large datasets (optional - can be enabled later)
-- ALTER TABLE auth_audit_log PARTITION BY RANGE (YEAR(created_at) * 100 + MONTH(created_at)) (...);

-- Add comments for documentation
ALTER TABLE auth_audit_log
COMMENT = 'Audit log for all authentication events. Risk-scored. GDPR retention: 90 days. Use summary table for dashboards.';

ALTER TABLE auth_audit_summary
COMMENT = 'Pre-aggregated daily summary for dashboard performance. Updated in real-time via triggers or batch jobs.';

ALTER TABLE auth_suspicious_activity
COMMENT = 'Security alerts for suspicious authentication patterns. Requires manual review and resolution.';
