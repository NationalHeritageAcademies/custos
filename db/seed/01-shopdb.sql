-- Seed data for the local dev database and the live integration harness.
USE shopdb;

CREATE TABLE products (
  id INT PRIMARY KEY AUTO_INCREMENT,
  sku VARCHAR(32) NOT NULL,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(40),
  price DECIMAL(10, 2) NOT NULL,
  in_stock INT NOT NULL,
  discontinued_at DATE NULL
);

INSERT INTO products (sku, name, category, price, in_stock, discontinued_at) VALUES
  ('KB-001', 'Mechanical Keyboard', 'peripherals', 129.00, 42, NULL),
  ('MS-014', 'Wireless Mouse', 'peripherals', 49.50, 0, '2026-03-01'),
  ('MN-027', '27-inch 4K Monitor', 'displays', 389.00, 7, NULL),
  ('DK-009', 'Standing Desk', 'furniture', 612.00, 3, NULL),
  ('CH-100', 'Ergo Chair', 'furniture', 245.00, 15, NULL),
  ('CB-USB', 'USB-C Cable', 'accessories', 12.99, 540, NULL),
  ('WH-055', 'Noise-cancelling Headphones', 'audio', 199.00, 0, '2026-06-15');

CREATE TABLE customers (
  id INT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(120),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO customers (email) VALUES ('a@example.com'), ('b@example.com');
