CREATE TABLE IF NOT EXISTS users(
 id CHAR(36) PRIMARY KEY,username VARCHAR(64) NOT NULL UNIQUE,email VARCHAR(190) NOT NULL UNIQUE,password_hash VARCHAR(255) NOT NULL,
 role ENUM('member','operator','finance','admin','superadmin') NOT NULL DEFAULT 'member',
 status ENUM('active','suspended','blocked','pending') NOT NULL DEFAULT 'active',display_name VARCHAR(120),phone VARCHAR(40),
 referral_code VARCHAR(32) UNIQUE,referred_by VARCHAR(32),created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,last_login_at TIMESTAMP NULL,INDEX(status,role)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS user_sessions(
 id CHAR(36) PRIMARY KEY,user_id CHAR(36) NOT NULL,token_hash CHAR(64) NOT NULL UNIQUE,device_id VARCHAR(190),
 session_type ENUM('member','backoffice') NOT NULL DEFAULT 'member',ip VARCHAR(64),user_agent VARCHAR(500),expires_at TIMESTAMP NOT NULL,
 revoked_at TIMESTAMP NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX(user_id),INDEX(expires_at),INDEX(user_id,session_type,revoked_at),
 FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS member_profiles(
 user_id CHAR(36) PRIMARY KEY,language VARCHAR(10) DEFAULT 'id',timezone VARCHAR(64) DEFAULT 'Asia/Jakarta',avatar_url TEXT,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS bank_accounts(
 id CHAR(36) PRIMARY KEY,user_id CHAR(36) NOT NULL,type VARCHAR(20) NOT NULL,provider VARCHAR(80) NOT NULL,account_number VARCHAR(120) NOT NULL,
 account_name VARCHAR(160) NOT NULL,routing_type VARCHAR(40),routing_value VARCHAR(120),is_primary BOOLEAN NOT NULL DEFAULT 1,verified_at TIMESTAMP NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX(user_id),FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS wallets(
 user_id CHAR(36) PRIMARY KEY,balance DECIMAL(20,2) NOT NULL DEFAULT 0,locked_balance DECIMAL(20,2) NOT NULL DEFAULT 0,locked BOOLEAN NOT NULL DEFAULT 0,
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS wallet_ledger(
 id CHAR(36) PRIMARY KEY,user_id CHAR(36) NOT NULL,transaction_id CHAR(36),reference VARCHAR(190) NOT NULL UNIQUE,direction ENUM('credit','debit') NOT NULL,
 amount DECIMAL(20,2) NOT NULL,balance_before DECIMAL(20,2) NOT NULL,balance_after DECIMAL(20,2) NOT NULL,reason VARCHAR(120) NOT NULL,
 metadata JSON,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX(user_id,created_at),FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS transactions(
 id CHAR(36) PRIMARY KEY,user_id CHAR(36) NOT NULL,type VARCHAR(40) NOT NULL,amount DECIMAL(20,2) NOT NULL,status VARCHAR(30) NOT NULL,
 reference VARCHAR(190) UNIQUE,metadata JSON,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX(user_id,created_at),FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS deposits(
 id CHAR(36) PRIMARY KEY,user_id CHAR(36) NOT NULL,amount DECIMAL(20,2) NOT NULL,status VARCHAR(30) NOT NULL DEFAULT 'pending',gateway VARCHAR(80),
 gateway_reference VARCHAR(190) UNIQUE,payment_request_id VARCHAR(190) UNIQUE,payment_url TEXT,qr_image_url TEXT,expires_at TIMESTAMP NULL,metadata JSON,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,INDEX(user_id,status),FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS withdrawals(
 id CHAR(36) PRIMARY KEY,user_id CHAR(36) NOT NULL,amount DECIMAL(20,2) NOT NULL,status VARCHAR(30) NOT NULL DEFAULT 'pending',
 bank_account_id CHAR(36),gateway_reference VARCHAR(190) UNIQUE,payout_id VARCHAR(190) UNIQUE,idempotency_key VARCHAR(190),reject_reason VARCHAR(500),metadata JSON,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 INDEX(user_id,status),UNIQUE KEY uq_withdrawal_idempotency(idempotency_key),FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(bank_account_id) REFERENCES bank_accounts(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS cashback_accounts(
 user_id CHAR(36) PRIMARY KEY,balance DECIMAL(20,2) NOT NULL DEFAULT 0,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS cashback_transactions(
 id CHAR(36) PRIMARY KEY,user_id CHAR(36) NOT NULL,amount DECIMAL(20,2) NOT NULL,type VARCHAR(40) NOT NULL,status VARCHAR(30) NOT NULL,
 reference VARCHAR(190) UNIQUE,metadata JSON,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX(user_id,created_at),FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS referrals(
 id CHAR(36) PRIMARY KEY,referrer_id CHAR(36) NOT NULL,referred_id CHAR(36) NOT NULL UNIQUE,code VARCHAR(32),created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(referrer_id) REFERENCES users(id),FOREIGN KEY(referred_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS providers(
 id CHAR(36) PRIMARY KEY,code VARCHAR(64) NOT NULL UNIQUE,name VARCHAR(120) NOT NULL,is_active BOOLEAN NOT NULL DEFAULT 1,sort_order INT NOT NULL DEFAULT 0,
 config_json JSON,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS provider_users(
 id CHAR(36) PRIMARY KEY,user_id CHAR(36) NOT NULL,provider_code VARCHAR(64) NOT NULL,provider_user_code VARCHAR(120) NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_provider_user(provider_code,user_id),UNIQUE KEY uq_provider_code(provider_code,provider_user_code),FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS games(
 id CHAR(36) PRIMARY KEY,provider_code VARCHAR(64) NOT NULL,provider_id VARCHAR(64),game_code VARCHAR(120) NOT NULL,name VARCHAR(190) NOT NULL,category VARCHAR(80),
 image_url TEXT,is_active BOOLEAN NOT NULL DEFAULT 1,is_popular BOOLEAN NOT NULL DEFAULT 0,is_new BOOLEAN NOT NULL DEFAULT 0,sort_order INT NOT NULL DEFAULT 0,
 metadata JSON,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY uq_game(provider_code,game_code),INDEX(provider_code,is_active,sort_order)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS game_launches(
 id CHAR(36) PRIMARY KEY,user_id CHAR(36) NOT NULL,game_id CHAR(36) NOT NULL,provider VARCHAR(64) NOT NULL,request_id VARCHAR(190) UNIQUE,
 provider_reference VARCHAR(190),status VARCHAR(30) NOT NULL,launch_url TEXT,expires_at TIMESTAMP NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(game_id) REFERENCES games(id),INDEX(user_id,created_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS provider_transactions(
 id CHAR(36) PRIMARY KEY,provider_code VARCHAR(64) NOT NULL,provider_transaction_id VARCHAR(190) NOT NULL,user_id CHAR(36),type VARCHAR(40) NOT NULL,
 amount DECIMAL(20,2) NOT NULL,status VARCHAR(30) NOT NULL,raw_json JSON,command VARCHAR(40),trans_guid VARCHAR(190),cancel_trans_guid VARCHAR(190),account VARCHAR(120),gplay_id VARCHAR(120),round_id VARCHAR(190),provider_id VARCHAR(64),game_code VARCHAR(120),balance_after DECIMAL(20,2),response_json JSON,canceled_at TIMESTAMP NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_provider_tx(provider_code,provider_transaction_id),INDEX(user_id,created_at),FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS provider_events(
 id CHAR(36) PRIMARY KEY,provider_code VARCHAR(64) NOT NULL,event_key VARCHAR(190) NOT NULL,command VARCHAR(40),raw_json JSON,payload_hash CHAR(64),processing_status VARCHAR(30) NOT NULL DEFAULT 'received',response_json JSON,
 processed_at TIMESTAMP NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,UNIQUE KEY uq_provider_event(provider_code,event_key)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS promotions(
 id CHAR(36) PRIMARY KEY,title VARCHAR(190) NOT NULL,description TEXT,image_url TEXT,start_at TIMESTAMP NULL,end_at TIMESTAMP NULL,
 is_active BOOLEAN NOT NULL DEFAULT 1,sort_order INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS payment_connections(
 id CHAR(36) PRIMARY KEY,name VARCHAR(120) NOT NULL,provider VARCHAR(80) NOT NULL,mode VARCHAR(20) NOT NULL,encrypted_config TEXT,
 is_active BOOLEAN NOT NULL DEFAULT 0,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS payment_orders(
 id CHAR(36) PRIMARY KEY,user_id CHAR(36) NOT NULL,reference VARCHAR(190) NOT NULL UNIQUE,amount DECIMAL(20,2) NOT NULL,channel VARCHAR(40) NOT NULL,
 status VARCHAR(30) NOT NULL DEFAULT 'pending',provider_reference VARCHAR(190) UNIQUE,payment_url TEXT,qr_image_url TEXT,raw_json JSON,expires_at TIMESTAMP NULL,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 INDEX(user_id,status),FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS webhook_events(
 id CHAR(36) PRIMARY KEY,source VARCHAR(80) NOT NULL,event_key VARCHAR(190) NOT NULL,signature_valid BOOLEAN NOT NULL DEFAULT 0,
 amount DECIMAL(20,2) NULL,payload JSON,processed_at TIMESTAMP NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_webhook(source,event_key)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS audit_logs(
 id CHAR(36) PRIMARY KEY,actor_user_id CHAR(36),action VARCHAR(120) NOT NULL,target_type VARCHAR(80),target_id VARCHAR(190),request_id VARCHAR(100),
 ip VARCHAR(64),metadata JSON,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,INDEX(created_at),INDEX(actor_user_id),FOREIGN KEY(actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS system_settings(
 setting_key VARCHAR(120) PRIMARY KEY,value_json JSON NOT NULL,updated_by CHAR(36),updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 FOREIGN KEY(updated_by) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS idempotency_keys(
 idempotency_key VARCHAR(190) PRIMARY KEY,user_id CHAR(36) NOT NULL,route VARCHAR(190) NOT NULL,response_json JSON NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 expires_at TIMESTAMP NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS schema_migrations(id VARCHAR(120) PRIMARY KEY,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS member_rtp_settings(
 user_id CHAR(36) PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT 0, rtp DECIMAL(6,3) NULL,
 min_rtp DECIMAL(6,3) NULL,max_rtp DECIMAL(6,3) NULL,reason VARCHAR(500),updated_by CHAR(36),
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(updated_by) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS rtp_audit_logs(
 id CHAR(36) PRIMARY KEY,user_id CHAR(36) NOT NULL,old_rtp DECIMAL(6,3) NULL,new_rtp DECIMAL(6,3) NULL,
 enabled BOOLEAN NOT NULL,actor_user_id CHAR(36),reason VARCHAR(500),created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 INDEX(user_id,created_at),FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS website_settings (
 id TINYINT PRIMARY KEY DEFAULT 1,
 site_name VARCHAR(120) NOT NULL DEFAULT 'BrandalBet',
 logo_url TEXT, favicon_url TEXT, primary_color VARCHAR(20), secondary_color VARCHAR(20),
 maintenance_mode BOOLEAN NOT NULL DEFAULT 0, registration_enabled BOOLEAN NOT NULL DEFAULT 1,
 game_launch_enabled BOOLEAN NOT NULL DEFAULT 1, wallet_enabled BOOLEAN NOT NULL DEFAULT 1,
 seo_title VARCHAR(180), seo_description TEXT, seo_keywords TEXT,
 hero_config JSON, navigation_config JSON, footer_config JSON, extra_config JSON,
 updated_by CHAR(36), updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 FOREIGN KEY(updated_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS game_display_settings (
 id CHAR(36) PRIMARY KEY, game_id CHAR(36) NOT NULL,
 section ENUM('popular','terbaru','all') NOT NULL DEFAULT 'all',
 display_order INT NOT NULL DEFAULT 0, is_visible BOOLEAN NOT NULL DEFAULT 1,
 custom_title VARCHAR(160), custom_image_url TEXT, extra_config JSON,
 updated_by CHAR(36), updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY uq_game_section(game_id,section), INDEX(section,is_visible,display_order),
 FOREIGN KEY(game_id) REFERENCES games(id), FOREIGN KEY(updated_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS provider_display_settings (
 id CHAR(36) PRIMARY KEY, provider_id CHAR(36) NOT NULL,
 display_order INT NOT NULL DEFAULT 0, is_visible BOOLEAN NOT NULL DEFAULT 1,
 extra_config JSON, updated_by CHAR(36), updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY uq_provider_display(provider_id),
 FOREIGN KEY(provider_id) REFERENCES providers(id), FOREIGN KEY(updated_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS payment_settings (
 id TINYINT PRIMARY KEY DEFAULT 1,
 deposit_enabled BOOLEAN NOT NULL DEFAULT 1, withdrawal_enabled BOOLEAN NOT NULL DEFAULT 1,
 min_deposit DECIMAL(20,2) NOT NULL DEFAULT 20000, max_deposit DECIMAL(20,2),
 min_withdrawal DECIMAL(20,2) NOT NULL DEFAULT 50000, max_withdrawal DECIMAL(20,2),
 deposit_fee DECIMAL(20,2) NOT NULL DEFAULT 0, withdrawal_fee DECIMAL(20,2) NOT NULL DEFAULT 0,
 channels JSON, extra_config JSON, updated_by CHAR(36),
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 FOREIGN KEY(updated_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reward_settings (
 id TINYINT PRIMARY KEY DEFAULT 1,
 cashback_enabled BOOLEAN NOT NULL DEFAULT 0, referral_enabled BOOLEAN NOT NULL DEFAULT 0,
 rules JSON, extra_config JSON, updated_by CHAR(36),
 updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 FOREIGN KEY(updated_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS member_security_settings (
 user_id CHAR(36) PRIMARY KEY,
 one_device_only BOOLEAN NOT NULL DEFAULT 1, login_enabled BOOLEAN NOT NULL DEFAULT 1,
 require_password_for_withdrawal BOOLEAN NOT NULL DEFAULT 1,
 extra_config JSON, updated_by CHAR(36), updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(updated_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS promotions_content (
 id CHAR(36) PRIMARY KEY, title VARCHAR(180) NOT NULL, slug VARCHAR(190) NOT NULL UNIQUE,
 description TEXT, image_url TEXT, start_at TIMESTAMP NULL, end_at TIMESTAMP NULL,
 is_active BOOLEAN NOT NULL DEFAULT 1, display_order INT NOT NULL DEFAULT 0,
 extra_config JSON, created_by CHAR(36), updated_by CHAR(36),
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 FOREIGN KEY(created_by) REFERENCES users(id), FOREIGN KEY(updated_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS admin_permissions (
 id CHAR(36) PRIMARY KEY, role VARCHAR(40) NOT NULL, permission_key VARCHAR(120) NOT NULL,
 allowed BOOLEAN NOT NULL DEFAULT 1, updated_by CHAR(36), updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
 UNIQUE KEY uq_role_permission(role,permission_key), FOREIGN KEY(updated_by) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS system_jobs (
 job_key VARCHAR(120) PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT 1,
 last_run_at TIMESTAMP NULL, last_success_at TIMESTAMP NULL, last_error TEXT,
 state_json JSON, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
