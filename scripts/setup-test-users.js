const bcrypt = require('bcrypt');
const { query } = require('../config/database');

/**
 * Setup test users with password "password"
 * Links modelexample to a proper user account
 */
async function setupTestUsers() {
    console.log('🔐 Setting up test users...');

    // Hash the password "password" with bcrypt (12 rounds)
    const passwordHash = await bcrypt.hash('password', 12);
    console.log('✅ Password hashed successfully');

    try {
        // 1. Check if admin@modelexample.com user exists
        const existingUser = await query(
            'SELECT id FROM users WHERE email = ?',
            ['admin@modelexample.com']
        );

        let modelExampleUserId;

        if (existingUser.length === 0) {
            // Create user for modelexample
            console.log('📝 Creating user for admin@modelexample.com...');
            const result = await query(`
                INSERT INTO users (
                    email,
                    password_hash,
                    role,
                    is_active,
                    email_verified,
                    email_verified_at,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, 'model', TRUE, TRUE, NOW(), NOW(), NOW())
            `, ['admin@modelexample.com', passwordHash]);

            modelExampleUserId = result.insertId;
            console.log(`✅ Created user ID ${modelExampleUserId} for admin@modelexample.com`);
        } else {
            modelExampleUserId = existingUser[0].id;
            console.log(`✅ User already exists: ID ${modelExampleUserId}`);

            // Update password
            await query(
                'UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?',
                [passwordHash, modelExampleUserId]
            );
            console.log('✅ Updated password for existing user');
        }

        // 2. Link user to modelexample model
        const modelResult = await query(
            'SELECT id FROM models WHERE slug = ?',
            ['modelexample']
        );

        if (modelResult.length > 0) {
            const modelId = modelResult[0].id;

            // Check if relationship exists
            const existingRelation = await query(
                'SELECT id FROM model_users WHERE model_id = ? AND user_id = ?',
                [modelId, modelExampleUserId]
            );

            if (existingRelation.length === 0) {
                // Create relationship
                await query(`
                    INSERT INTO model_users (
                        model_id,
                        user_id,
                        role,
                        is_active,
                        added_at
                    )
                    VALUES (?, ?, 'owner', TRUE, NOW())
                `, [modelId, modelExampleUserId]);
                console.log(`✅ Linked user ${modelExampleUserId} to modelexample (model ${modelId})`);
            } else {
                console.log('✅ User already linked to modelexample model');
            }
        }

        // 3. Update all existing test users with the password
        const testUsers = [
            'admin@musenest.com',
            'admin@testmodel.com',
            'admin@camgirl.com',
            'testuser@musenest.com',
            'testadmin@musenest.com',
            'test@test.com',
            'admin@escortmodel.com',
            'test1754344975948@example.com'
        ];

        console.log('\n📝 Updating passwords for all test users...');

        for (const email of testUsers) {
            const result = await query(
                'UPDATE users SET password_hash = ?, updated_at = NOW() WHERE email = ?',
                [passwordHash, email]
            );

            if (result.affectedRows > 0) {
                console.log(`✅ Updated password for ${email}`);
            } else {
                console.log(`⚠️  User ${email} not found`);
            }
        }

        // 4. Display summary
        console.log('\n' + '='.repeat(60));
        console.log('✅ TEST USER SETUP COMPLETE');
        console.log('='.repeat(60));
        console.log('\n📋 Test User Credentials:');
        console.log('   Email: admin@modelexample.com (for /modelexample/admin)');
        console.log('   Password: password');
        console.log('\n   All other test accounts also have password: password');
        console.log('\n🔗 Login at: http://localhost:3000/login');
        console.log('🔗 Model Admin: http://localhost:3000/modelexample/admin');
        console.log('='.repeat(60) + '\n');

    } catch (error) {
        console.error('❌ Error setting up test users:', error);
        process.exit(1);
    }

    process.exit(0);
}

// Run the setup
setupTestUsers();
