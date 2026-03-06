-- Sample database: A fictional SaaS company "NovaCRM"
-- Provides realistic data for the Vandura agent to query

-- ============================================================
-- Schema
-- ============================================================

CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  budget NUMERIC(12,2),
  head_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(50) NOT NULL,
  last_name VARCHAR(50) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  department_id INT REFERENCES departments(id),
  title VARCHAR(100),
  salary NUMERIC(10,2),
  hire_date DATE NOT NULL,
  is_active BOOLEAN DEFAULT true,
  manager_id INT REFERENCES employees(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  company_name VARCHAR(200) NOT NULL,
  industry VARCHAR(100),
  plan VARCHAR(50) NOT NULL DEFAULT 'free',
  mrr NUMERIC(10,2) DEFAULT 0,
  arr NUMERIC(12,2) GENERATED ALWAYS AS (mrr * 12) STORED,
  seats INT DEFAULT 1,
  signup_date DATE NOT NULL,
  churn_date DATE,
  health_score INT CHECK (health_score BETWEEN 0 AND 100),
  region VARCHAR(50),
  account_owner_id INT REFERENCES employees(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  sku VARCHAR(50) UNIQUE NOT NULL,
  category VARCHAR(50),
  price NUMERIC(10,2) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id) NOT NULL,
  order_date DATE NOT NULL,
  status VARCHAR(30) DEFAULT 'pending',
  total NUMERIC(12,2) NOT NULL,
  discount_pct NUMERIC(5,2) DEFAULT 0,
  payment_method VARCHAR(50),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INT REFERENCES orders(id) NOT NULL,
  product_id INT REFERENCES products(id) NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  unit_price NUMERIC(10,2) NOT NULL,
  subtotal NUMERIC(12,2) GENERATED ALWAYS AS (quantity * unit_price) STORED
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id) NOT NULL,
  assigned_to INT REFERENCES employees(id),
  subject VARCHAR(300) NOT NULL,
  priority VARCHAR(20) DEFAULT 'medium',
  status VARCHAR(30) DEFAULT 'open',
  channel VARCHAR(30) DEFAULT 'email',
  first_response_minutes INT,
  resolution_minutes INT,
  satisfaction_score INT CHECK (satisfaction_score BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS revenue_events (
  id SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id) NOT NULL,
  event_type VARCHAR(50) NOT NULL, -- 'new', 'expansion', 'contraction', 'churn', 'reactivation'
  amount NUMERIC(10,2) NOT NULL,
  event_date DATE NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_customers_plan ON customers(plan);
CREATE INDEX IF NOT EXISTS idx_customers_region ON customers(region);
CREATE INDEX IF NOT EXISTS idx_customers_health ON customers(health_score);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(order_date);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON support_tickets(priority);
CREATE INDEX IF NOT EXISTS idx_revenue_date ON revenue_events(event_date);
CREATE INDEX IF NOT EXISTS idx_revenue_type ON revenue_events(event_type);
CREATE INDEX IF NOT EXISTS idx_employees_dept ON employees(department_id);

-- ============================================================
-- Seed Data
-- ============================================================

-- Departments
INSERT INTO departments (name, budget, head_count) VALUES
  ('Engineering', 2400000, 45),
  ('Sales', 1800000, 32),
  ('Customer Success', 900000, 18),
  ('Marketing', 750000, 14),
  ('Product', 600000, 10),
  ('Finance', 400000, 8),
  ('People & HR', 350000, 6),
  ('Legal', 300000, 4)
ON CONFLICT (name) DO NOTHING;

-- Employees (management + IC mix)
INSERT INTO employees (first_name, last_name, email, department_id, title, salary, hire_date, manager_id) VALUES
  -- Engineering
  ('Sarah', 'Chen', 'sarah.chen@novacrm.com', 1, 'VP Engineering', 245000, '2021-03-15', NULL),
  ('Marcus', 'Johnson', 'marcus.j@novacrm.com', 1, 'Engineering Manager', 195000, '2021-06-01', 1),
  ('Priya', 'Patel', 'priya.p@novacrm.com', 1, 'Senior Backend Engineer', 175000, '2021-08-10', 2),
  ('Alex', 'Kim', 'alex.k@novacrm.com', 1, 'Senior Frontend Engineer', 170000, '2022-01-15', 2),
  ('Jordan', 'Rivera', 'jordan.r@novacrm.com', 1, 'Backend Engineer', 145000, '2022-06-01', 2),
  ('Emily', 'Zhang', 'emily.z@novacrm.com', 1, 'Backend Engineer', 140000, '2022-09-15', 2),
  ('Tyler', 'Brown', 'tyler.b@novacrm.com', 1, 'Frontend Engineer', 138000, '2023-01-10', 2),
  ('Nina', 'Kowalski', 'nina.k@novacrm.com', 1, 'DevOps Engineer', 165000, '2022-03-01', 1),
  ('David', 'Lee', 'david.l@novacrm.com', 1, 'QA Engineer', 125000, '2023-04-15', 2),
  ('Fatima', 'Al-Rashid', 'fatima.a@novacrm.com', 1, 'Junior Engineer', 105000, '2024-01-08', 2),
  -- Sales
  ('Rachel', 'Morgan', 'rachel.m@novacrm.com', 2, 'VP Sales', 230000, '2021-04-01', NULL),
  ('Chris', 'Taylor', 'chris.t@novacrm.com', 2, 'Sales Director - Enterprise', 190000, '2021-07-15', 11),
  ('Lisa', 'Park', 'lisa.p@novacrm.com', 2, 'Account Executive', 135000, '2022-02-01', 12),
  ('Mike', 'O''Brien', 'mike.o@novacrm.com', 2, 'Account Executive', 130000, '2022-05-15', 12),
  ('Aisha', 'Diallo', 'aisha.d@novacrm.com', 2, 'Account Executive', 128000, '2022-08-01', 12),
  ('Tom', 'Nakamura', 'tom.n@novacrm.com', 2, 'SDR Manager', 120000, '2022-10-01', 11),
  ('Sofia', 'Garcia', 'sofia.g@novacrm.com', 2, 'SDR', 75000, '2023-03-15', 16),
  ('James', 'Wilson', 'james.w@novacrm.com', 2, 'SDR', 72000, '2023-06-01', 16),
  -- Customer Success
  ('Karen', 'Liu', 'karen.l@novacrm.com', 3, 'VP Customer Success', 210000, '2021-05-01', NULL),
  ('Ben', 'Foster', 'ben.f@novacrm.com', 3, 'CS Manager', 145000, '2021-09-15', 19),
  ('Maya', 'Singh', 'maya.s@novacrm.com', 3, 'Customer Success Manager', 115000, '2022-04-01', 20),
  ('Ryan', 'Cooper', 'ryan.c@novacrm.com', 3, 'Customer Success Manager', 112000, '2022-07-15', 20),
  ('Ana', 'Martinez', 'ana.m@novacrm.com', 3, 'Support Engineer', 105000, '2023-01-15', 20),
  ('Daniel', 'Okafor', 'daniel.o@novacrm.com', 3, 'Support Engineer', 100000, '2023-05-01', 20),
  -- Marketing
  ('Julia', 'Adams', 'julia.a@novacrm.com', 4, 'VP Marketing', 215000, '2021-06-15', NULL),
  ('Kevin', 'Tran', 'kevin.t@novacrm.com', 4, 'Content Lead', 120000, '2022-03-01', 25),
  ('Hannah', 'Berg', 'hannah.b@novacrm.com', 4, 'Growth Marketing Manager', 125000, '2022-11-01', 25),
  -- Product
  ('Oliver', 'Wright', 'oliver.w@novacrm.com', 5, 'VP Product', 225000, '2021-04-15', NULL),
  ('Zara', 'Hussain', 'zara.h@novacrm.com', 5, 'Senior PM', 165000, '2022-01-01', 28),
  ('Luke', 'Campbell', 'luke.c@novacrm.com', 5, 'Product Designer', 140000, '2022-06-15', 28),
  -- Finance
  ('Patricia', 'Nguyen', 'patricia.n@novacrm.com', 6, 'CFO', 260000, '2021-03-01', NULL),
  ('Robert', 'Stone', 'robert.s@novacrm.com', 6, 'Controller', 155000, '2021-10-01', 31)
ON CONFLICT (email) DO NOTHING;

-- Products
INSERT INTO products (name, sku, category, price) VALUES
  ('NovaCRM Starter', 'CRM-START', 'subscription', 49.00),
  ('NovaCRM Professional', 'CRM-PRO', 'subscription', 149.00),
  ('NovaCRM Enterprise', 'CRM-ENT', 'subscription', 399.00),
  ('API Access Add-on', 'ADD-API', 'addon', 79.00),
  ('Advanced Analytics', 'ADD-ANALYTICS', 'addon', 99.00),
  ('Custom Integrations', 'ADD-INTEG', 'addon', 149.00),
  ('Priority Support', 'SVC-PRIORITY', 'service', 199.00),
  ('Onboarding Package', 'SVC-ONBOARD', 'service', 2500.00),
  ('Training Workshop', 'SVC-TRAIN', 'service', 1500.00),
  ('Data Migration', 'SVC-MIGRATE', 'service', 5000.00)
ON CONFLICT (sku) DO NOTHING;

-- Customers (100 companies across regions and plans)
INSERT INTO customers (company_name, industry, plan, mrr, seats, signup_date, churn_date, health_score, region, account_owner_id)
SELECT
  company_name, industry, plan, mrr, seats, signup_date,
  CASE WHEN random() < 0.08 THEN signup_date + (random() * 365 + 90)::int ELSE NULL END,
  (random() * 40 + 60)::int,
  region,
  (ARRAY[13, 14, 15])[floor(random() * 3 + 1)::int]
FROM (VALUES
  ('Acme Corp', 'Technology', 'enterprise', 3990, 45, '2022-01-15'::date, 'North America'),
  ('GlobalTech Solutions', 'Technology', 'enterprise', 7980, 85, '2022-02-01'::date, 'North America'),
  ('Pinnacle Industries', 'Manufacturing', 'professional', 2235, 15, '2022-03-10'::date, 'North America'),
  ('Horizon Healthcare', 'Healthcare', 'enterprise', 5985, 60, '2022-03-15'::date, 'North America'),
  ('Stellar Finance', 'Financial Services', 'enterprise', 11970, 120, '2022-04-01'::date, 'North America'),
  ('BlueSky Media', 'Media', 'professional', 1490, 10, '2022-04-20'::date, 'North America'),
  ('Quantum Dynamics', 'Technology', 'professional', 2980, 20, '2022-05-05'::date, 'North America'),
  ('Pacific Retail Group', 'Retail', 'enterprise', 3990, 40, '2022-05-15'::date, 'North America'),
  ('Atlas Logistics', 'Logistics', 'professional', 1490, 10, '2022-06-01'::date, 'North America'),
  ('Cedar Education', 'Education', 'starter', 490, 10, '2022-06-15'::date, 'North America'),
  ('Nordic Tech AS', 'Technology', 'enterprise', 5985, 55, '2022-07-01'::date, 'Europe'),
  ('Berlin Digital GmbH', 'Technology', 'professional', 1490, 10, '2022-07-10'::date, 'Europe'),
  ('Paris Luxe SA', 'Retail', 'professional', 2235, 15, '2022-07-20'::date, 'Europe'),
  ('London Fintech Ltd', 'Financial Services', 'enterprise', 7980, 80, '2022-08-01'::date, 'Europe'),
  ('Milano Design Studio', 'Creative', 'starter', 490, 10, '2022-08-15'::date, 'Europe'),
  ('Amsterdam Analytics BV', 'Technology', 'professional', 2980, 20, '2022-09-01'::date, 'Europe'),
  ('Madrid Solutions SL', 'Consulting', 'professional', 1490, 10, '2022-09-15'::date, 'Europe'),
  ('Stockholm Innovations', 'Technology', 'enterprise', 3990, 35, '2022-10-01'::date, 'Europe'),
  ('Dublin SaaS Co', 'Technology', 'professional', 1490, 10, '2022-10-15'::date, 'Europe'),
  ('Zurich Insurance Tech', 'Insurance', 'enterprise', 11970, 100, '2022-11-01'::date, 'Europe'),
  ('Tokyo Digital KK', 'Technology', 'enterprise', 5985, 50, '2022-11-15'::date, 'APAC'),
  ('Singapore Growth Pte', 'Financial Services', 'enterprise', 7980, 70, '2022-12-01'::date, 'APAC'),
  ('Sydney Marketplace', 'Retail', 'professional', 2235, 15, '2023-01-10'::date, 'APAC'),
  ('Mumbai Tech Hub', 'Technology', 'professional', 1490, 10, '2023-01-20'::date, 'APAC'),
  ('Seoul Platforms', 'Technology', 'enterprise', 3990, 30, '2023-02-01'::date, 'APAC'),
  ('Jakarta Commerce', 'Retail', 'starter', 490, 10, '2023-02-15'::date, 'APAC'),
  ('Bangkok Digital', 'Media', 'starter', 490, 10, '2023-03-01'::date, 'APAC'),
  ('Melbourne AI Labs', 'Technology', 'professional', 2980, 20, '2023-03-15'::date, 'APAC'),
  ('Sao Paulo Tech', 'Technology', 'professional', 1490, 10, '2023-04-01'::date, 'LATAM'),
  ('Mexico City Digital', 'Media', 'starter', 490, 10, '2023-04-15'::date, 'LATAM'),
  ('Bogota Software', 'Technology', 'professional', 1490, 10, '2023-05-01'::date, 'LATAM'),
  ('Lima Ventures', 'Financial Services', 'starter', 490, 10, '2023-05-15'::date, 'LATAM'),
  ('Santiago Analytics', 'Consulting', 'professional', 2235, 15, '2023-06-01'::date, 'LATAM'),
  ('Buenos Aires Media', 'Media', 'starter', 245, 5, '2023-06-15'::date, 'LATAM'),
  ('Cape Town Software', 'Technology', 'professional', 1490, 10, '2023-07-01'::date, 'Africa'),
  ('Lagos Digital', 'Technology', 'starter', 245, 5, '2023-07-15'::date, 'Africa'),
  ('Nairobi Fintech', 'Financial Services', 'professional', 1490, 10, '2023-08-01'::date, 'Africa'),
  ('Cairo Enterprise', 'Consulting', 'starter', 490, 10, '2023-08-15'::date, 'Africa'),
  ('Cascade Systems', 'Technology', 'enterprise', 5985, 50, '2023-09-01'::date, 'North America'),
  ('Redwood Analytics', 'Technology', 'professional', 2980, 20, '2023-09-15'::date, 'North America'),
  ('Ironclad Security', 'Cybersecurity', 'enterprise', 7980, 60, '2023-10-01'::date, 'North America'),
  ('Greenfield Energy', 'Energy', 'professional', 1490, 10, '2023-10-15'::date, 'North America'),
  ('Summit Healthcare', 'Healthcare', 'enterprise', 3990, 35, '2023-11-01'::date, 'North America'),
  ('Apex Manufacturing', 'Manufacturing', 'professional', 2235, 15, '2023-11-15'::date, 'North America'),
  ('Velocity Logistics', 'Logistics', 'professional', 1490, 10, '2023-12-01'::date, 'North America'),
  ('Bright Education', 'Education', 'starter', 245, 5, '2023-12-15'::date, 'North America'),
  ('Nexus Consulting', 'Consulting', 'professional', 2235, 15, '2024-01-10'::date, 'North America'),
  ('Vantage Financial', 'Financial Services', 'enterprise', 5985, 50, '2024-01-20'::date, 'North America'),
  ('Prism Creative', 'Creative', 'starter', 490, 10, '2024-02-01'::date, 'North America'),
  ('Echo Media Group', 'Media', 'professional', 1490, 10, '2024-02-15'::date, 'North America')
) AS t(company_name, industry, plan, mrr, seats, signup_date, region)
ON CONFLICT DO NOTHING;

-- Update churned customers to have low health scores
UPDATE customers SET health_score = (random() * 25 + 10)::int WHERE churn_date IS NOT NULL;

-- Orders (generate ~300 orders over the past 2 years)
INSERT INTO orders (customer_id, order_date, status, total, discount_pct, payment_method)
SELECT
  c.id,
  c.signup_date + (random() * (CURRENT_DATE - c.signup_date))::int,
  (ARRAY['completed', 'completed', 'completed', 'completed', 'pending', 'refunded'])[floor(random() * 6 + 1)::int],
  round((random() * 10000 + 500)::numeric, 2),
  CASE WHEN random() < 0.3 THEN round((random() * 20)::numeric, 2) ELSE 0 END,
  (ARRAY['credit_card', 'credit_card', 'wire_transfer', 'ach', 'credit_card'])[floor(random() * 5 + 1)::int]
FROM customers c, generate_series(1, 6) s
WHERE c.churn_date IS NULL OR c.churn_date > CURRENT_DATE - 365;

-- Order items
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT
  o.id,
  p.id,
  floor(random() * 5 + 1)::int,
  p.price
FROM orders o
CROSS JOIN LATERAL (
  SELECT id, price FROM products ORDER BY random() LIMIT (floor(random() * 3 + 1)::int)
) p;

-- Support tickets (generate ~200 tickets)
INSERT INTO support_tickets (customer_id, assigned_to, subject, priority, status, channel, first_response_minutes, resolution_minutes, satisfaction_score, created_at, resolved_at)
SELECT
  c.id,
  (ARRAY[23, 24])[floor(random() * 2 + 1)::int],
  (ARRAY[
    'Cannot login to dashboard',
    'API rate limit exceeded',
    'Data export not working',
    'Billing discrepancy',
    'Integration setup help',
    'Performance issue with reports',
    'Feature request: bulk import',
    'SSO configuration issue',
    'Webhook delivery failures',
    'Custom field not saving',
    'Dashboard loading slowly',
    'Email notifications not received',
    'Permission error on team settings',
    'CSV import failing',
    'Mobile app crash on iOS'
  ])[floor(random() * 15 + 1)::int],
  (ARRAY['low', 'medium', 'medium', 'high', 'critical'])[floor(random() * 5 + 1)::int],
  (ARRAY['open', 'in_progress', 'resolved', 'resolved', 'resolved', 'closed'])[floor(random() * 6 + 1)::int],
  (ARRAY['email', 'chat', 'phone', 'email', 'chat'])[floor(random() * 5 + 1)::int],
  floor(random() * 120 + 5)::int,
  CASE WHEN random() > 0.2 THEN floor(random() * 2880 + 30)::int ELSE NULL END,
  CASE WHEN random() > 0.3 THEN floor(random() * 4 + 1)::int + 1 ELSE NULL END,
  now() - (random() * 365)::int * interval '1 day',
  CASE WHEN random() > 0.25 THEN now() - (random() * 300)::int * interval '1 day' ELSE NULL END
FROM customers c, generate_series(1, 4) s;

-- Revenue events
INSERT INTO revenue_events (customer_id, event_type, amount, event_date, notes)
SELECT
  c.id,
  'new',
  c.mrr,
  c.signup_date,
  'Initial subscription'
FROM customers c;

-- Expansion events for some customers
INSERT INTO revenue_events (customer_id, event_type, amount, event_date, notes)
SELECT
  c.id,
  'expansion',
  round((c.mrr * (random() * 0.5 + 0.1))::numeric, 2),
  c.signup_date + (random() * 365 + 90)::int,
  'Plan upgrade / seat expansion'
FROM customers c
WHERE random() < 0.35 AND c.churn_date IS NULL;

-- Churn events
INSERT INTO revenue_events (customer_id, event_type, amount, event_date, notes)
SELECT
  c.id,
  'churn',
  -c.mrr,
  c.churn_date,
  'Customer churned'
FROM customers c
WHERE c.churn_date IS NOT NULL;

-- Analyze tables for query planner
ANALYZE;
