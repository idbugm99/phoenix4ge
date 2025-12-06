const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const { authenticateToken, generateToken } = require('../../middleware/auth');
const oauthService = require('../services/OAuthService');
const authAuditService = require('../services/AuthAuditService');
const refreshTokenService = require('../services/RefreshTokenService');

const router = express.Router();

// Initialize Passport strategies
function initializeOAuthStrategies() {
    // Google OAuth Strategy
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
        passport.use(new GoogleStrategy({
            clientID: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/api/auth/oauth/google/callback',
            passReqToCallback: true
        }, async (req, accessToken, refreshToken, profile, done) => {
            try {
                return done(null, { profile, accessToken, refreshToken });
            } catch (error) {
                return done(error, null);
            }
        }));
        console.log('✅ Google OAuth strategy initialized');
    } else {
        console.log('⚠️  Google OAuth not configured (missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET)');
    }

    // Facebook OAuth Strategy
    if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
        passport.use(new FacebookStrategy({
            clientID: process.env.FACEBOOK_APP_ID,
            clientSecret: process.env.FACEBOOK_APP_SECRET,
            callbackURL: process.env.FACEBOOK_CALLBACK_URL || 'http://localhost:3000/api/auth/oauth/facebook/callback',
            profileFields: ['id', 'displayName', 'email', 'picture.type(large)'],
            passReqToCallback: true
        }, async (req, accessToken, refreshToken, profile, done) => {
            try {
                return done(null, { profile, accessToken, refreshToken });
            } catch (error) {
                return done(error, null);
            }
        }));
        console.log('✅ Facebook OAuth strategy initialized');
    } else {
        console.log('⚠️  Facebook OAuth not configured (missing FACEBOOK_APP_ID or FACEBOOK_APP_SECRET)');
    }
}

// Initialize strategies
initializeOAuthStrategies();

/**
 * GET /api/auth/oauth/google
 * Initiate Google OAuth flow
 */
router.get('/oauth/google', async (req, res, next) => {
    try {
        const action = req.query.action || 'login'; // login, signup, link
        const returnUrl = req.query.returnUrl || '/';

        // Generate state token for CSRF protection
        const stateToken = await oauthService.generateStateToken(
            'google',
            action,
            req.user?.id || null,
            req.ip,
            req.get('user-agent'),
            returnUrl
        );

        // Redirect to Google OAuth
        passport.authenticate('google', {
            scope: ['profile', 'email'],
            state: stateToken,
            session: false
        })(req, res, next);

    } catch (error) {
        console.error('Google OAuth initiation error:', error);
        res.fail(500, 'OAuth failed', {
            message: 'Unable to initiate Google OAuth'
        });
    }
});

/**
 * GET /api/auth/oauth/google/callback
 * Google OAuth callback
 */
router.get('/oauth/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: '/login?error=oauth_failed' }),
    async (req, res) => {
        try {
            const { profile, accessToken, refreshToken: oauthRefreshToken } = req.user;
            const stateToken = req.query.state;

            // Verify state token
            const state = await oauthService.verifyStateToken(stateToken);
            if (!state) {
                return res.redirect('/login?error=invalid_state');
            }

            const providerUserId = profile.id;
            const email = profile.emails[0].value;

            // Check if OAuth account already linked
            let existingUser = await oauthService.findUserByOAuth('google', providerUserId);

            if (existingUser) {
                // Existing OAuth user - log them in
                await oauthService.updateOAuthUsage('google', providerUserId);

                // Generate tokens
                const token = generateToken({ id: existingUser.user_id, email: existingUser.email, role: existingUser.role });
                const tokens = await refreshTokenService.createRefreshToken(existingUser.user_id, req.ip, req.get('user-agent'));

                // Log OAuth login
                await authAuditService.logEvent({
                    eventType: 'oauth_login',
                    eventCategory: 'authentication',
                    userId: existingUser.user_id,
                    email: email,
                    success: true,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                    metadata: { provider: 'google' }
                });

                return res.redirect(`/login-success?token=${token}&refreshToken=${tokens.refreshToken}`);
            }

            if (state.action === 'link') {
                // Link OAuth to existing authenticated user
                if (!state.userId) {
                    return res.redirect('/login?error=not_authenticated');
                }

                await oauthService.linkOAuthAccount(state.userId, 'google', profile);

                // Log OAuth linking
                await authAuditService.logEvent({
                    eventType: 'oauth_linked',
                    eventCategory: 'account_management',
                    userId: state.userId,
                    success: true,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                    metadata: { provider: 'google' }
                });

                return res.redirect('/settings/security?success=google_linked');
            }

            // New user - check if email exists
            const userByEmail = await oauthService.findUserByEmail(email);

            if (userByEmail) {
                // Email exists - link OAuth to existing account
                await oauthService.linkOAuthAccount(userByEmail.id, 'google', profile);

                // Generate tokens
                const token = generateToken(userByEmail);
                const tokens = await refreshTokenService.createRefreshToken(userByEmail.id, req.ip, req.get('user-agent'));

                // Log OAuth linking + login
                await authAuditService.logEvent({
                    eventType: 'oauth_linked_and_login',
                    eventCategory: 'authentication',
                    userId: userByEmail.id,
                    email: email,
                    success: true,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                    metadata: { provider: 'google' }
                });

                return res.redirect(`/login-success?token=${token}&refreshToken=${tokens.refreshToken}`);
            }

            // Create new user from OAuth
            const newUser = await oauthService.createUserFromOAuth('google', profile);
            await oauthService.linkOAuthAccount(newUser.id, 'google', profile);

            // Generate tokens
            const token = generateToken(newUser);
            const tokens = await refreshTokenService.createRefreshToken(newUser.id, req.ip, req.get('user-agent'));

            // Log OAuth signup
            await authAuditService.logEvent({
                eventType: 'oauth_signup',
                eventCategory: 'authentication',
                userId: newUser.id,
                email: email,
                success: true,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
                metadata: { provider: 'google' }
            });

            return res.redirect(`/login-success?token=${token}&refreshToken=${tokens.refreshToken}&newUser=true`);

        } catch (error) {
            console.error('Google OAuth callback error:', error);
            res.redirect('/login?error=oauth_error');
        }
    }
);

/**
 * GET /api/auth/oauth/facebook
 * Initiate Facebook OAuth flow
 */
router.get('/oauth/facebook', async (req, res, next) => {
    try {
        const action = req.query.action || 'login';
        const returnUrl = req.query.returnUrl || '/';

        const stateToken = await oauthService.generateStateToken(
            'facebook',
            action,
            req.user?.id || null,
            req.ip,
            req.get('user-agent'),
            returnUrl
        );

        passport.authenticate('facebook', {
            scope: ['email', 'public_profile'],
            state: stateToken,
            session: false
        })(req, res, next);

    } catch (error) {
        console.error('Facebook OAuth initiation error:', error);
        res.fail(500, 'OAuth failed', {
            message: 'Unable to initiate Facebook OAuth'
        });
    }
});

/**
 * GET /api/auth/oauth/facebook/callback
 * Facebook OAuth callback
 */
router.get('/oauth/facebook/callback',
    passport.authenticate('facebook', { session: false, failureRedirect: '/login?error=oauth_failed' }),
    async (req, res) => {
        try {
            const { profile, accessToken } = req.user;
            const stateToken = req.query.state;

            const state = await oauthService.verifyStateToken(stateToken);
            if (!state) {
                return res.redirect('/login?error=invalid_state');
            }

            const providerUserId = profile.id;
            const email = profile.emails?.[0]?.value;

            if (!email) {
                return res.redirect('/login?error=no_email');
            }

            // Similar logic to Google OAuth
            let existingUser = await oauthService.findUserByOAuth('facebook', providerUserId);

            if (existingUser) {
                await oauthService.updateOAuthUsage('facebook', providerUserId);

                const token = generateToken({ id: existingUser.user_id, email: existingUser.email, role: existingUser.role });
                const tokens = await refreshTokenService.createRefreshToken(existingUser.user_id, req.ip, req.get('user-agent'));

                await authAuditService.logEvent({
                    eventType: 'oauth_login',
                    eventCategory: 'authentication',
                    userId: existingUser.user_id,
                    email: email,
                    success: true,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                    metadata: { provider: 'facebook' }
                });

                return res.redirect(`/login-success?token=${token}&refreshToken=${tokens.refreshToken}`);
            }

            if (state.action === 'link') {
                if (!state.userId) {
                    return res.redirect('/login?error=not_authenticated');
                }

                await oauthService.linkOAuthAccount(state.userId, 'facebook', profile);

                await authAuditService.logEvent({
                    eventType: 'oauth_linked',
                    eventCategory: 'account_management',
                    userId: state.userId,
                    success: true,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                    metadata: { provider: 'facebook' }
                });

                return res.redirect('/settings/security?success=facebook_linked');
            }

            const userByEmail = await oauthService.findUserByEmail(email);

            if (userByEmail) {
                await oauthService.linkOAuthAccount(userByEmail.id, 'facebook', profile);

                const token = generateToken(userByEmail);
                const tokens = await refreshTokenService.createRefreshToken(userByEmail.id, req.ip, req.get('user-agent'));

                await authAuditService.logEvent({
                    eventType: 'oauth_linked_and_login',
                    eventCategory: 'authentication',
                    userId: userByEmail.id,
                    email: email,
                    success: true,
                    ipAddress: req.ip,
                    userAgent: req.get('user-agent'),
                    metadata: { provider: 'facebook' }
                });

                return res.redirect(`/login-success?token=${token}&refreshToken=${tokens.refreshToken}`);
            }

            const newUser = await oauthService.createUserFromOAuth('facebook', profile);
            await oauthService.linkOAuthAccount(newUser.id, 'facebook', profile);

            const token = generateToken(newUser);
            const tokens = await refreshTokenService.createRefreshToken(newUser.id, req.ip, req.get('user-agent'));

            await authAuditService.logEvent({
                eventType: 'oauth_signup',
                eventCategory: 'authentication',
                userId: newUser.id,
                email: email,
                success: true,
                ipAddress: req.ip,
                userAgent: req.get('user-agent'),
                metadata: { provider: 'facebook' }
            });

            return res.redirect(`/login-success?token=${token}&refreshToken=${tokens.refreshToken}&newUser=true`);

        } catch (error) {
            console.error('Facebook OAuth callback error:', error);
            res.redirect('/login?error=oauth_error');
        }
    }
);

/**
 * GET /api/auth/oauth/accounts
 * Get user's linked OAuth accounts
 * Requires authentication
 */
router.get('/oauth/accounts', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const accounts = await oauthService.getUserOAuthAccounts(userId);

        res.json({
            message: 'OAuth accounts retrieved successfully',
            accounts: accounts,
            count: accounts.length
        });

    } catch (error) {
        console.error('Get OAuth accounts error:', error);
        res.fail(500, 'Failed to get accounts', {
            message: 'Unable to retrieve OAuth accounts'
        });
    }
});

/**
 * DELETE /api/auth/oauth/accounts/:accountId
 * Revoke OAuth account link
 * Requires authentication
 */
router.delete('/oauth/accounts/:accountId', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const accountId = parseInt(req.params.accountId);

        await oauthService.revokeOAuthAccount(accountId, userId);

        // Log revocation
        await authAuditService.logEvent({
            eventType: 'oauth_unlinked',
            eventCategory: 'account_management',
            userId: userId,
            email: req.user.email,
            success: true,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
            metadata: { accountId: accountId }
        });

        res.json({
            message: 'OAuth account unlinked successfully',
            accountId: accountId
        });

    } catch (error) {
        console.error('Revoke OAuth account error:', error);
        res.fail(500, 'Failed to revoke account', {
            message: 'Unable to revoke OAuth account'
        });
    }
});

module.exports = router;
