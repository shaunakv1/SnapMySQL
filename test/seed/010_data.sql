-- Seed data
INSERT INTO users (email, full_name, is_active) VALUES
  ('alice@example.com','Alice Example',1),
  ('bob@example.com','Bob Example',1),
  ('carol@example.com','Carol Example',0);

INSERT INTO orders (user_id, amount) VALUES
  (1, 19.99),
  (1, 49.00),
  (2, 10.00);
