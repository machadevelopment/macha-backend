// Barrel export — all 27 tables across domains. Import from '@/db/schema'.
export * from './companies';
export * from './identity'; // users, company_users, staff
export * from './dimensions'; // products, stores, fx_rates
export * from './ledger'; // transactions, invoices, bills (partitioned)
export * from './ingestion'; // documents, staging_rows, industry_templates(+versions)
export * from './dashboard'; // metric_rollups
export * from './chat'; // chats, chat_messages, chat_segments
export * from './ai'; // ai_usage_events, credit_transactions, insight_requests
export * from './reporting'; // reports, report_versions, alert_rules, alert_events
export * from './notifications'; // notifications
export * from './audit'; // admin_audit_log
