import express from "express";
import "express-async-errors";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import nodemailer from "nodemailer";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key";

import pool, { initDB } from "./db";

async function initializeDatabase() {
  try {
    console.log("Ensuring database exists at:", process.env.DB_HOST || 'localhost');
    await initDB();
    console.log("Database ensured. Creating tables...");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) UNIQUE,
        password VARCHAR(255),
        name VARCHAR(255),
        role VARCHAR(50) DEFAULT 'staff'
      );
    `);

    // Create default admin if no users exist
    const [users]: any = await pool.query("SELECT COUNT(*) as count FROM users");
    if (users[0].count === 0) {
      console.log("No users found. Creating default admin...");
      const hashedPassword = await bcrypt.hash("admin123", 10);
      await pool.query("INSERT INTO users (email, password, name, role) VALUES (?, ?, ?, ?)", 
        ["admin@example.com", hashedPassword, "Admin", "admin"]);
      console.log("Default admin created: admin@example.com / admin123");
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        name VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(50),
        source VARCHAR(100),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (user_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        name VARCHAR(255),
        type VARCHAR(50), 
        cost_price DECIMAL(10,2),
        selling_price DECIMAL(10,2),
        INDEX (user_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sales (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        customer_id INT,
        product_id INT,
        amount DECIMAL(10,2),
        profit DECIMAL(10,2),
        payment_method VARCHAR(100),
        date DATETIME,
        renewal_date DATETIME,
        last_email_sent_at DATETIME,
        status VARCHAR(50) DEFAULT 'Pending',
        order_id VARCHAR(255),
        day30_sent TINYINT(1) DEFAULT 0,
        day15_sent TINYINT(1) DEFAULT 0,
        expired_sent TINYINT(1) DEFAULT 0,
        INDEX (user_id),
        INDEX (customer_id),
        INDEX (product_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE SET NULL,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE SET NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS renewal_email_settings (
        user_id INT PRIMARY KEY,
        day30_subject TEXT,
        day30_body TEXT,
        day15_subject TEXT,
        day15_body TEXT,
        expired_subject TEXT,
        expired_body TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS smtp_settings (
        user_id INT PRIMARY KEY,
        host VARCHAR(255),
        port INT,
        user VARCHAR(255),
        pass VARCHAR(255),
        from_email VARCHAR(255),
        from_name VARCHAR(255),
        secure TINYINT(1) DEFAULT 1,
        is_verified TINYINT(1) DEFAULT 0,
        last_verified_at DATETIME,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    try {
      await pool.query(`ALTER TABLE smtp_settings ADD COLUMN is_verified TINYINT(1) DEFAULT 0`);
    } catch (e) {}
    try {
      await pool.query(`ALTER TABLE smtp_settings ADD COLUMN last_verified_at DATETIME`);
    } catch (e) {}

    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_email_templates (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT UNIQUE,
        subject TEXT,
        body TEXT,
        FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS canva_renewal_orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        name VARCHAR(255),
        phone VARCHAR(50),
        email VARCHAR(255),
        package_name VARCHAR(255),
        price DECIMAL(10,2),
        payment_method VARCHAR(100),
        sender_number VARCHAR(50),
        transaction_id VARCHAR(255),
        status VARCHAR(50) DEFAULT 'Pending',
        created_at DATETIME,
        INDEX (user_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS canva_renewal_settings (
        user_id INT PRIMARY KEY,
        packages TEXT,
        payment_info TEXT,
        banner_url TEXT,
        page_title VARCHAR(255),
        page_description TEXT,
        bkash_logo TEXT,
        nagad_logo TEXT,
        rocket_logo TEXT,
        redirect_url VARCHAR(255),
        approval_email_template TEXT,
        rejection_email_template TEXT,
        approval_email_subject VARCHAR(255),
        rejection_email_subject VARCHAR(255),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS global_templates (
        user_id INT PRIMARY KEY,
        approved_subject TEXT,
        approved_body TEXT,
        rejected_subject TEXT,
        rejected_body TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS branding_settings (
        user_id INT PRIMARY KEY,
        logo_url TEXT,
        admin_logo_url TEXT,
        favicon_url TEXT,
        site_name VARCHAR(255),
        show_floating_login TINYINT(1) DEFAULT 1,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // Ensure show_floating_login column exists
    try {
      await pool.query(`ALTER TABLE branding_settings ADD COLUMN show_floating_login TINYINT(1) DEFAULT 1`);
    } catch (e) {}

    // Ensure columns for Canva settings (incremental updates)
    const columns = [
      'bkash_logo', 'nagad_logo', 'rocket_logo', 'redirect_url',
      'approval_email_template', 'rejection_email_template',
      'approval_email_subject', 'rejection_email_subject'
    ];
    for (const col of columns) {
      try {
        await pool.query(`ALTER TABLE canva_renewal_settings ADD COLUMN ${col} TEXT`);
      } catch (e) {}
    }

    const saleExtraColumns = ['day30_sent', 'day15_sent', 'expired_sent', 'last_email_sent_at'];
    for (const col of saleExtraColumns) {
      try {
        if (col === 'last_email_sent_at') {
          await pool.query(`ALTER TABLE sales ADD COLUMN last_email_sent_at DATETIME`);
        } else {
          await pool.query(`ALTER TABLE sales ADD COLUMN ${col} TINYINT(1) DEFAULT 0`);
        }
      } catch (e) {}
    }

    // Seed data
    const [rows]: any = await pool.query("SELECT COUNT(*) as count FROM users");
    if (rows[0].count === 0) {
      const hashedPassword = bcrypt.hashSync("admin123", 10);
      const [userResult]: any = await pool.query("INSERT INTO users (email, password, name, role) VALUES (?, ?, ?, ?)", ["admin@example.com", hashedPassword, "Admin User", "admin"]);
      const userId = userResult.insertId;

      await pool.query("INSERT INTO customers (user_id, name, email, phone, source) VALUES (?, ?, ?, ?, ?)", [userId, "Jane Doe", "jane@example.com", "987654321", "WooCommerce"]);
      const [cRows]: any = await pool.query("SELECT id FROM customers WHERE user_id = ? LIMIT 1", [userId]);
      const customerId = cRows[0].id;

      await pool.query("INSERT INTO products (user_id, name, type, cost_price, selling_price) VALUES (?, ?, ?, ?, ?)", [userId, "Monthly Plan", "1month", 10, 29]);
      const [pRows]: any = await pool.query("SELECT id FROM products WHERE user_id = ? LIMIT 1", [userId]);
      const productId = pRows[0].id;

      await pool.query("INSERT INTO sales (user_id, customer_id, product_id, amount, profit, payment_method, date) VALUES (?, ?, ?, ?, ?, ?, ?)", [userId, customerId, productId, 29, 19, "bKash", new Date()]);
    }

    console.log("Database initialized successfully");
  } catch (err) {
    console.error("Database initialization failed:", err);
  }
}

async function startServer() {
  await initializeDatabase();
  const app = express();
  app.use(express.json());

  // Define API Router
  const apiRouter = express.Router();

  // API cache control middleware
  apiRouter.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    next();
  });

  // Health and Status Routes (First)
  apiRouter.get("/health", async (req, res) => {
    try {
      const startTime = Date.now();
      await pool.query("SELECT 1");
      const latency = Date.now() - startTime;
      res.json({ status: "ok", latency: `${latency}ms`, database: "connected" });
    } catch (err: any) {
      console.error("Health Check Failed:", err);
      res.status(500).json({ status: "error", error: err.message, database: "disconnected" });
    }
  });

  apiRouter.get("/db-status", async (req, res) => {
    try {
      const startTime = Date.now();
      await pool.query("SELECT 1");
      const latency = Date.now() - startTime;
      res.json({ 
        status: "connected", 
        latency: `${latency}ms`, 
        timestamp: new Date().toISOString()
      });
    } catch (err: any) {
      console.error("DB Status Check Failed:", err);
      res.status(500).json({ 
        status: "disconnected", 
        error: err.message, 
        timestamp: new Date().toISOString() 
      });
    }
  });

  // Helper for SMTP Transport
  const getTransporter = (smtp: any) => {
    if (!smtp || !smtp.host) return null;
    
    const host = (smtp.host || "").trim();
    const user = (smtp.user || "").trim();
    const pass = (smtp.pass || "").trim();
    const port = parseInt(smtp.port || "587");
    
    // Explicitly handle Gmail as a special case using the service preset
    if (host.toLowerCase().includes('gmail') || user.toLowerCase().includes('gmail.com')) {
      console.log(`[SMTP] Using Gmail preset for ${user}`);
      return nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass },
        debug: true,
        logger: true,
        tls: {
          rejectUnauthorized: false
        }
      });
    }
    
    let isSecure = port === 465;
    if (port !== 465 && (smtp.secure === 1 || smtp.secure === true || smtp.secure === "1" || smtp.secure === "true")) {
      isSecure = true;
    }

    console.log(`[SMTP] Using custom host: ${host}, port: ${port}, secure: ${isSecure}`);
    return nodemailer.createTransport({
      host: host,
      port: port,
      secure: isSecure,
      auth: { user, pass },
      tls: { 
        rejectUnauthorized: false,
        minVersion: 'TLSv1.2',
        servername: host
      },
      connectionTimeout: 15000, 
      greetingTimeout: 15000,
      socketTimeout: 20000,
      debug: true,
      logger: true
    });
  };

  // Auth Middleware
  const authenticate = (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Unauthorized" });
    
    const token = authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      next();
    } catch (err) {
      res.status(401).json({ error: "Invalid token" });
    }
  };

  // Auth Routes
  apiRouter.post("/auth/register", async (req, res) => {
    const { email, password, name } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    try {
      const [result]: any = await pool.query("INSERT INTO users (email, password, name) VALUES (?, ?, ?)", [email, hashedPassword, name]);
      const userId = result.insertId;
      const token = jwt.sign({ id: userId, email, name }, JWT_SECRET);
      res.json({ token, user: { id: userId, email, name } });
    } catch (err) {
      res.status(400).json({ error: "Email already exists" });
    }
  });

  apiRouter.post("/auth/login", async (req, res) => {
    const { email, password } = req.body;
    const [rows]: any = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  });

  // Dashboard Stats
  apiRouter.get("/stats", authenticate, async (req: any, res) => {
    const userId = req.user.id;
    const [salesRows]: any = await pool.query("SELECT SUM(amount) as revenue, SUM(profit) as profit FROM sales WHERE user_id = ?", [userId]);
    const [customersRows]: any = await pool.query("SELECT COUNT(*) as count FROM customers WHERE user_id = ?", [userId]);
    
    res.json({
      revenue: parseFloat(salesRows[0].revenue) || 0,
      profit: parseFloat(salesRows[0].profit) || 0,
      customers: customersRows[0].count || 0
    });
  });

  // Products
  apiRouter.get("/products", authenticate, async (req: any, res) => {
    const [rows]: any = await pool.query("SELECT * FROM products WHERE user_id = ?", [req.user.id]);
    res.json(rows);
  });

  apiRouter.post("/products", authenticate, async (req: any, res) => {
    const { name, type, selling_price } = req.body;
    const cost_price = 0;
    const [result]: any = await pool.query("INSERT INTO products (user_id, name, type, cost_price, selling_price) VALUES (?, ?, ?, ?, ?)",
      [req.user.id, name, type, cost_price, selling_price]);
    res.json({ id: result.insertId });
  });

  apiRouter.put("/products/:id", authenticate, async (req: any, res) => {
    const { name, type, selling_price } = req.body;
    const cost_price = 0;
    await pool.query("UPDATE products SET name = ?, type = ?, cost_price = ?, selling_price = ? WHERE id = ? AND user_id = ?",
      [name, type, cost_price, selling_price, req.params.id, req.user.id]);
    res.json({ success: true });
  });

  apiRouter.delete("/products/:id", authenticate, async (req: any, res) => {
    await pool.query("DELETE FROM product_email_templates WHERE product_id = ?", [req.params.id]);
    const [result]: any = await pool.query("DELETE FROM products WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Product not found" });
    res.json({ success: true });
  });

  // Customers
  apiRouter.get("/customers", authenticate, async (req: any, res) => {
    const [rows]: any = await pool.query("SELECT * FROM customers WHERE user_id = ? ORDER BY created_at DESC", [req.user.id]);
    res.json(rows);
  });

  apiRouter.post("/customers", authenticate, async (req: any, res) => {
    const { name, email, phone, source } = req.body;
    const [result]: any = await pool.query("INSERT INTO customers (user_id, name, email, phone, source) VALUES (?, ?, ?, ?, ?)", 
      [req.user.id, name, email, phone, source]);
    res.json({ id: result.insertId });
  });

  // Sales
  apiRouter.get("/sales", authenticate, async (req: any, res) => {
    const [rows]: any = await pool.query(`
      SELECT s.*, c.name as customer_name, c.email, c.phone, p.name as product_name 
      FROM sales s
      JOIN customers c ON s.customer_id = c.id
      JOIN products p ON s.product_id = p.id
      WHERE s.user_id = ?
      ORDER BY s.date DESC
    `, [req.user.id]);
    res.json(rows);
  });

  apiRouter.post("/sales", authenticate, async (req: any, res) => {
    const { name, email, phone, product_id, amount, profit, payment_method, date, renewal_date } = req.body;
    
    let customerId;
    let [rows]: any = await pool.query("SELECT id FROM customers WHERE ((email = ? AND email != '') OR (phone = ? AND phone != '')) AND user_id = ?", 
      [email || '___none___', phone || '___none___', req.user.id]);
    
    if (rows.length > 0) {
      customerId = rows[0].id;
      await pool.query("UPDATE customers SET name = ?, phone = ?, email = ? WHERE id = ?", [name, phone, email, customerId]);
    } else {
      const [result]: any = await pool.query("INSERT INTO customers (user_id, name, email, phone, source) VALUES (?, ?, ?, ?, ?)",
        [req.user.id, name, email || null, phone || null, 'Manual']);
      customerId = result.insertId;
    }

    const [result]: any = await pool.query("INSERT INTO sales (user_id, customer_id, product_id, amount, profit, payment_method, date, renewal_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [req.user.id, customerId, product_id, amount, profit, payment_method, date, renewal_date]);
    res.json({ id: result.insertId });
  });

  apiRouter.post("/sales/:id/status", authenticate, async (req: any, res) => {
    const { status } = req.body;
    const saleId = req.params.id;
    const userId = req.user.id;
    
    await pool.query("UPDATE sales SET status = ? WHERE id = ? AND user_id = ?", [status, saleId, userId]);

    // Send status email if template exists
    try {
      const [sRows]: any = await pool.query(`
        SELECT s.*, c.name as customer_name, c.email as customer_email, p.name as product_name
        FROM sales s
        JOIN customers c ON s.customer_id = c.id
        JOIN products p ON s.product_id = p.id
        WHERE s.id = ?
      `, [saleId]);
      const sale = sRows[0];
      
      const [gRows]: any = await pool.query("SELECT * FROM global_templates WHERE user_id = ?", [userId]);
      const templates = gRows[0];
      
      const [smtpRows]: any = await pool.query("SELECT * FROM smtp_settings WHERE user_id = ?", [userId]);
      const smtp = smtpRows[0];

      if (sale && templates && smtp && sale.customer_email) {
        const type = status === 'Approved' ? 'approved' : 'rejected';
        const subjectTemplate = templates[`${type}_subject`];
        const bodyTemplate = templates[`${type}_body`];

        if (subjectTemplate && bodyTemplate) {
          const transporter = getTransporter(smtp);
          if (transporter) {
            const adminName = smtp.from_name || "Admin";
            const renewalDateStr = sale.renewal_date ? new Date(sale.renewal_date).toLocaleDateString() : "N/A";
            
            const replacements: any = {
              '{customer_name}': sale.customer_name || 'Customer',
              '{name}': sale.customer_name || 'Customer',
              '{product_name}': sale.product_name,
              '{product}': sale.product_name,
              '{renewal_date}': renewalDateStr,
              '{admin_name}': adminName,
              '{status}': status
            };

            let subject = subjectTemplate;
            let body = bodyTemplate;
            Object.keys(replacements).forEach(k => {
              const regex = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
              subject = subject.replace(regex, replacements[k]);
              body = body.replace(regex, replacements[k]);
            });

            await transporter.sendMail({
              from: `"${adminName}" <${smtp.from_email || smtp.user}>`,
              to: sale.customer_email,
              subject: subject,
              text: body,
              html: body.replace(/\n/g, '<br>')
            });
          }
        }
      }
    } catch (e) {
      console.error("Sales Status Email Error:", e);
    }

    res.json({ success: true });
  });

  // Bulk Email Campaigns
  apiRouter.post("/email-campaign/customers", authenticate, async (req: any, res) => {
    const { subject, body } = req.body;
    const userId = req.user.id;

    try {
      const [customers]: any = await pool.query("SELECT email, name FROM customers WHERE user_id = ? AND email IS NOT NULL AND email != ''", [userId]);
      const [smtpRows]: any = await pool.query("SELECT * FROM smtp_settings WHERE user_id = ?", [userId]);
      const smtp = smtpRows[0];

      if (!smtp) return res.status(400).json({ error: "SMTP settings not configured." });
      const transporter = getTransporter(smtp);
      if (!transporter) throw new Error("Could not initialize email transporter");

      let count = 0;
      for (const customer of customers) {
        try {
          const adminName = smtp.from_name || "Admin";
          const replacements: any = {
            '{customer_name}': customer.name || 'Customer',
            '{name}': customer.name || 'Customer',
            '{admin_name}': adminName,
            '{{name}}': customer.name || 'Customer',
            '{{customer_name}}': customer.name || 'Customer'
          };

          let personalizedSubject = subject;
          let personalizedBody = body;

          Object.keys(replacements).forEach(k => {
            const regex = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
            personalizedSubject = personalizedSubject.replace(regex, replacements[k]);
            personalizedBody = personalizedBody.replace(regex, replacements[k]);
          });

          await transporter.sendMail({
            from: `"${adminName}" <${smtp.from_email || smtp.user}>`,
            to: customer.email,
            subject: personalizedSubject,
            text: personalizedBody,
            html: personalizedBody.replace(/\n/g, '<br>')
          });
          count++;
        } catch (e) {
          console.error(`Failed to send campaign email to ${customer.email}:`, e);
        }
      }

      res.json({ success: true, count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  apiRouter.post("/email-campaign/manual", authenticate, async (req: any, res) => {
    const { subject, body, emails } = req.body;
    const userId = req.user.id;

    try {
      const [smtpRows]: any = await pool.query("SELECT * FROM smtp_settings WHERE user_id = ?", [userId]);
      const smtp = smtpRows[0];

      if (!smtp) return res.status(400).json({ error: "SMTP settings not configured." });
      const transporter = getTransporter(smtp);
      if (!transporter) throw new Error("Could not initialize email transporter");

      let count = 0;
      for (const email of emails) {
        try {
          await transporter.sendMail({
            from: `"${smtp.from_name || 'DigiSheba'}" <${smtp.from_email || smtp.user}>`,
            to: email,
            subject: subject,
            text: body,
            html: body.replace(/\n/g, '<br>')
          });
          count++;
        } catch (e) {
          console.error(`Failed to send manual email to ${email}:`, e);
        }
      }

      res.json({ success: true, count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Send Renewal Email (Inspired by user's PHP code)
  apiRouter.post("/sales/:id/send-renewal-email", authenticate, async (req: any, res) => {
    const saleId = req.params.id;
    const userId = req.user.id;

    try {
      // 1. Fetch sale with related info
      const [sRows]: any = await pool.query(`
        SELECT s.*, c.name as customer_name, c.email as customer_email, p.name as product_name, p.id as product_id
        FROM sales s
        JOIN customers c ON s.customer_id = c.id
        JOIN products p ON s.product_id = p.id
        WHERE s.id = ? AND s.user_id = ?
      `, [saleId, userId]);
      
      const sale = sRows[0];
      if (!sale) return res.status(404).json({ error: "Sale not found" });
      if (!sale.customer_email) return res.status(400).json({ error: "Customer has no email address" });

      // 2. Fetch SMTP settings
      const [smtpRows]: any = await pool.query("SELECT * FROM smtp_settings WHERE user_id = ?", [userId]);
      const smtp = smtpRows[0];
      if (!smtp) return res.status(400).json({ error: "SMTP settings not configured. Please set them up in Settings." });

      // 3. Fetch Product template (or global fallback)
      const [tRows]: any = await pool.query("SELECT * FROM product_email_templates WHERE product_id = ?", [sale.product_id]);
      const productTemplate = tRows[0];

      let subject = productTemplate?.subject;
      let body = productTemplate?.body;

      if (!subject || !body) {
        // Try to fetch 30-day renewal settings as fallback
        const [settRows]: any = await pool.query("SELECT * FROM renewal_email_settings WHERE user_id = ?", [userId]);
        const rSettings = settRows[0];
        if (rSettings?.day30_subject && rSettings?.day30_body) {
          subject = subject || rSettings.day30_subject;
          body = body || rSettings.day30_body;
        }
      }

      subject = subject || `Renewal Reminder: ${sale.product_name}`;
      body = body || `Hello {customer_name},\n\nYour subscription for {product_name} is expiring on {renewal_date}. Please renew to continue our service.\n\nRegards,\n{admin_name}`;

      // 4. Replace Placeholders (supporting user's PHP placeholders too)
      const adminName = smtp.from_name || "Admin";
      const renewalDateStr = sale.renewal_date ? new Date(sale.renewal_date).toLocaleDateString() : "N/A";
      
      const replacements: any = {
        '{customer_name}': sale.customer_name || 'Customer',
        '{name}': sale.customer_name || 'Customer', // PHP style
        '{product_name}': sale.product_name,
        '{product}': sale.product_name, // PHP style
        '{renewal_date}': renewalDateStr,
        '{admin_name}': adminName,
        '{{customer_name}}': sale.customer_name || 'Customer',
        '{{product_name}}': sale.product_name,
        '{{renewal_date}}': renewalDateStr
      };

      Object.keys(replacements).forEach(key => {
        const regex = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        subject = subject.replace(regex, replacements[key]);
        body = body.replace(regex, replacements[key]);
      });

      // 5. Send Email
      const transporter = getTransporter(smtp);
      if (!transporter) throw new Error("Could not initialize email transporter");

      await transporter.sendMail({
        from: `"${adminName}" <${smtp.from_email || smtp.user}>`,
        to: sale.customer_email,
        subject: subject,
        text: body,
        html: body.replace(/\n/g, '<br>')
      });

      // 6. Update last sent timestamp (PHP logic)
      const now = new Date();
      await pool.query("UPDATE sales SET last_email_sent_at = ? WHERE id = ?", [now, saleId]);

      res.json({ success: true, sentAt: now });
    } catch (err: any) {
      console.error("Manual Email Error:", err);
      res.status(500).json({ error: "Failed to send email: " + err.message });
    }
  });

  apiRouter.delete("/sales/:id", authenticate, async (req: any, res) => {
    const [result]: any = await pool.query("DELETE FROM sales WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: "Sale not found" });
    res.json({ success: true });
  });

  // Global Templates
  apiRouter.get("/settings/templates", authenticate, async (req: any, res) => {
    const [rows]: any = await pool.query("SELECT * FROM global_templates WHERE user_id = ?", [req.user.id]);
    res.json(rows[0] || {
      approved_subject: "Order Approved: {product_name}",
      approved_body: "Hi {customer_name},\n\nYour order for {product_name} has been approved.\n\nThank you!",
      rejected_subject: "Order Update: {product_name}",
      rejected_body: "Hi {customer_name},\n\nUnfortunately, we couldn't approve your recent order for {product_name}.\n\nPlease contact us for details."
    });
  });

  apiRouter.post("/settings/templates", authenticate, async (req: any, res) => {
    const { approved_subject, approved_body, rejected_subject, rejected_body } = req.body;
    await pool.query(`
      INSERT INTO global_templates (user_id, approved_subject, approved_body, rejected_subject, rejected_body)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        approved_subject=VALUES(approved_subject), approved_body=VALUES(approved_body), 
        rejected_subject=VALUES(rejected_subject), rejected_body=VALUES(rejected_body)
    `, [req.user.id, approved_subject, approved_body, rejected_subject, rejected_body]);
    res.json({ success: true });
  });

  // Settings
  apiRouter.get("/settings/branding", authenticate, async (req: any, res) => {
    const [rows]: any = await pool.query("SELECT * FROM branding_settings WHERE user_id = ?", [req.user.id]);
    res.json(rows[0] || { site_name: 'DigiSheba', logo_url: '' });
  });

  apiRouter.post("/settings/branding", authenticate, async (req: any, res) => {
    const { logo_url, admin_logo_url, favicon_url, site_name, show_floating_login } = req.body;
    await pool.query(`
      INSERT INTO branding_settings (user_id, logo_url, admin_logo_url, favicon_url, site_name, show_floating_login)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        logo_url=VALUES(logo_url), admin_logo_url=VALUES(admin_logo_url), favicon_url=VALUES(favicon_url), site_name=VALUES(site_name), show_floating_login=VALUES(show_floating_login)
    `, [req.user.id, logo_url, admin_logo_url, favicon_url, site_name, show_floating_login ? 1 : 0]);
    res.json({ success: true });
  });

  apiRouter.get("/settings/smtp", authenticate, async (req: any, res) => {
    const [rows]: any = await pool.query("SELECT * FROM smtp_settings WHERE user_id = ?", [req.user.id]);
    res.json(rows[0] || {});
  });

  apiRouter.post("/settings/smtp", authenticate, async (req: any, res) => {
    const { host, port, user, pass, from_email, from_name, secure } = req.body;
    await pool.query(`
      INSERT INTO smtp_settings (user_id, host, port, user, pass, from_email, from_name, secure, is_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON DUPLICATE KEY UPDATE 
        host=VALUES(host), port=VALUES(port), user=VALUES(user), pass=VALUES(pass), 
        from_email=VALUES(from_email), from_name=VALUES(from_name), secure=VALUES(secure),
        is_verified=0
    `, [req.user.id, host, port, user, pass, from_email, from_name, secure ? 1 : 0]);
    res.json({ success: true });
  });

  // Settings Routes
  apiRouter.post("/settings/smtp/test", authenticate, async (req: any, res) => {
    let transporter: any = null;
    try {
      const { host, port, user, pass, from_email, from_name, secure, email } = req.body;
      console.log(`[SMTP TEST] Request from user ${req.user.id} to host: ${host}`);
      
      transporter = getTransporter({ host, port, user, pass, secure });
      if (!transporter) {
        console.error("[SMTP TEST] Transporter creation failed");
        return res.status(400).json({ error: "Invalid SMTP configuration (host missing?)" });
      }

      console.log("[SMTP TEST] Verifying connection...");
      await transporter.verify();
      console.log("[SMTP TEST] Connection verified successfully");
      
      const mailOptions = {
        from: `"${from_name || 'DigiSheba Test'}" <${from_email || user}>`,
        to: (email || user).trim(),
        subject: "SMTP Test Successful",
        text: "Your SMTP settings are working perfectly!",
        html: "<b>Success!</b><p>Your SMTP settings are working perfectly. This is a test email.</p>",
      };

      console.log(`[SMTP TEST] Sending test mail to: ${mailOptions.to}`);
      await transporter.sendMail(mailOptions);
      console.log("[SMTP TEST] Mail sent successfully");

      // Update verification status in DB
      await pool.query(`
        UPDATE smtp_settings 
        SET is_verified = 1, last_verified_at = NOW() 
        WHERE user_id = ?
      `, [req.user.id]);

      return res.json({ success: true, message: "Test email sent!" });
    } catch (err: any) {
      console.error("[SMTP TEST] Caught Error:", err);
      
      let advice = "Check your host, port, and credentials.";
      const portStr = String(req.body.port);
      
      if (portStr === "25") advice = "Port 25 is often blocked. Try 587 or 465.";
      if (err.code === 'ETIMEDOUT') advice = "Connection timed out. Check your firewall settings.";
      if (err.code === 'ECONNREFUSED') advice = "Connection refused. Ensure the port is correct.";
      if (err.message && (err.message.toLowerCase().includes('login') || err.message.includes('535'))) {
        advice = "Login failed. For Gmail, you MUST use an 'App Password', not your regular password.";
      }
      if (err.message && err.message.includes('invalid response')) {
        advice = "Server returned invalid response. Try changing the 'Secure' toggle.";
      }
      
      return res.status(500).json({ 
        error: "SMTP test failed", 
        details: err.message || "No error message provided",
        code: err.code || "N/A",
        advice: advice
      });
    } finally {
      if (transporter) {
        try { transporter.close(); } catch (e) {}
      }
    }
  });

  // Public Routes (Mounted on /api but accessible publicly)
  apiRouter.get("/public/products", async (req, res) => {
    const [uRows]: any = await pool.query("SELECT DISTINCT user_id FROM products LIMIT 1");
    if (uRows.length === 0) return res.json([]);
    const [rows]: any = await pool.query("SELECT * FROM products WHERE user_id = ?", [uRows[0].user_id]);
    res.json(rows);
  });

  apiRouter.get("/public/track", async (req, res) => {
    const { email } = req.query as any;
    if (!email) return res.status(400).json({ error: "Email required" });
    const [rows]: any = await pool.query(`
      SELECT s.*, p.name as product_name, c.email
      FROM sales s
      JOIN customers c ON s.customer_id = c.id
      JOIN products p ON s.product_id = p.id
      WHERE LOWER(c.email) = LOWER(?)
      ORDER BY s.date DESC
    `, [email.trim()]);
    res.json(rows);
  });

  // Canva Renewal (Admin)
  apiRouter.get("/admin/canva-renewal/orders", authenticate, async (req: any, res) => {
    const [rows]: any = await pool.query("SELECT * FROM canva_renewal_orders WHERE user_id = ? ORDER BY created_at DESC", [req.user.id]);
    res.json(rows);
  });

  apiRouter.get("/admin/canva-renewal/settings", authenticate, async (req: any, res) => {
    const [rows]: any = await pool.query("SELECT * FROM canva_renewal_settings WHERE user_id = ?", [req.user.id]);
    const settings = rows[0] || {};
    if (settings.packages && typeof settings.packages === 'string') settings.packages = JSON.parse(settings.packages);
    if (settings.payment_info && typeof settings.payment_info === 'string') settings.payment_info = JSON.parse(settings.payment_info);
    res.json(settings);
  });

  apiRouter.post("/admin/canva-renewal/settings", authenticate, async (req: any, res) => {
    const { packages, payment_info, banner_url, page_title, page_description, bkash_logo, nagad_logo, rocket_logo, redirect_url, approval_email_template, rejection_email_template, approval_email_subject, rejection_email_subject } = req.body;
    await pool.query(`
      INSERT INTO canva_renewal_settings 
      (user_id, packages, payment_info, banner_url, page_title, page_description, bkash_logo, nagad_logo, rocket_logo, redirect_url, approval_email_template, rejection_email_template, approval_email_subject, rejection_email_subject)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        packages=VALUES(packages), payment_info=VALUES(payment_info), banner_url=VALUES(banner_url), 
        page_title=VALUES(page_title), page_description=VALUES(page_description),
        bkash_logo=VALUES(bkash_logo), nagad_logo=VALUES(nagad_logo), rocket_logo=VALUES(rocket_logo),
        redirect_url=VALUES(redirect_url), approval_email_template=VALUES(approval_email_template),
        rejection_email_template=VALUES(rejection_email_template), 
        approval_email_subject=VALUES(approval_email_subject), rejection_email_subject=VALUES(rejection_email_subject)
    `, [req.user.id, JSON.stringify(packages), JSON.stringify(payment_info), banner_url, page_title, page_description, bkash_logo, nagad_logo, rocket_logo, redirect_url, approval_email_template, rejection_email_template, approval_email_subject, rejection_email_subject]);
    res.json({ success: true });
  });

  apiRouter.patch("/admin/canva-renewal/orders/:id/status", authenticate, async (req: any, res) => {
    const { status } = req.body;
    const orderId = req.params.id;
    const userId = req.user.id;

    await pool.query("UPDATE canva_renewal_orders SET status = ? WHERE id = ?", [status, orderId]);

    // Send Status Email
    try {
      const [oRows]: any = await pool.query("SELECT * FROM canva_renewal_orders WHERE id = ?", [orderId]);
      const order = oRows[0];
      const [sRows]: any = await pool.query("SELECT * FROM canva_renewal_settings WHERE user_id = ?", [userId]);
      const settings = sRows[0];
      const [smtpRows]: any = await pool.query("SELECT * FROM smtp_settings WHERE user_id = ?", [userId]);
      const smtp = smtpRows[0];

      if (order && settings && smtp) {
        const type = status === 'Approved' ? 'approval' : 'rejection';
        const subjectTemplate = settings[`${type}_email_subject`];
        const bodyTemplate = settings[`${type}_email_template`];

        if (subjectTemplate && bodyTemplate) {
          const transporter = getTransporter(smtp);
          if (transporter) {
            const replacements: any = {
              '{customer_name}': order.name || 'Customer',
              '{name}': order.name || 'Customer',
              '{product_name}': order.package_name,
              '{product}': order.package_name,
              '{status}': status,
              '{admin_name}': smtp.from_name || 'Admin',
              '{{customer_name}}': order.name || 'Customer',
              '{{product_name}}': order.package_name
            };
            let subject = subjectTemplate;
            let body = bodyTemplate;
            Object.keys(replacements).forEach(k => {
              subject = subject.replace(new RegExp(k, 'g'), replacements[k]);
              body = body.replace(new RegExp(k, 'g'), replacements[k]);
            });

            await transporter.sendMail({
              from: `"${smtp.from_name || 'DigiSheba'}" <${smtp.from_email || smtp.user}>`,
              to: order.email,
              subject: subject,
              text: body,
              html: body.replace(/\n/g, '<br>')
            });
          }
        }
      }
    } catch (e) {
      console.error("Order Status Email Error:", e);
    }

    res.json({ success: true });
  });

  apiRouter.delete("/admin/canva-renewal/orders/:id", authenticate, async (req: any, res) => {
    await pool.query("DELETE FROM canva_renewal_orders WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  // User Management
  apiRouter.get("/users", authenticate, async (req: any, res) => {
    const [rows]: any = await pool.query("SELECT id, name, email FROM users");
    res.json(rows);
  });

  apiRouter.post("/users", authenticate, async (req: any, res) => {
    const { name, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [name, email, hashedPassword]);
    res.json({ success: true });
  });

  apiRouter.delete("/users/:id", authenticate, async (req: any, res) => {
    if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: "Cannot delete self" });
    await pool.query("DELETE FROM users WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  });

  apiRouter.patch("/profile", authenticate, async (req: any, res) => {
    const { name, email, password } = req.body;
    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      await pool.query("UPDATE users SET name = ?, email = ?, password = ? WHERE id = ?", [name, email, hashedPassword, req.user.id]);
    } else {
      await pool.query("UPDATE users SET name = ?, email = ? WHERE id = ?", [name, email, req.user.id]);
    }
    res.json({ success: true });
  });

  // Renewal Email Settings
  apiRouter.get("/settings/renewal-emails", authenticate, async (req: any, res) => {
    const [rows]: any = await pool.query("SELECT * FROM renewal_email_settings WHERE user_id = ?", [req.user.id]);
    res.json(rows[0] || {
      day30_subject: "Renewal Alert: 30 Days Remaining",
      day30_body: "Hi {customer_name},\n\nYour subscription for {product_name} will expire in 30 days.\n\nThank you!",
      day15_subject: "Renewal Alert: 15 Days Remaining",
      day15_body: "Hi {customer_name},\n\nYour subscription for {product_name} will expire in 15 days. Please renew soon.\n\nThank you!",
      expired_subject: "Subscription Expired",
      expired_body: "Hi {customer_name},\n\nYour subscription for {product_name} has expired."
    });
  });

  apiRouter.post("/settings/renewal-emails", authenticate, async (req: any, res) => {
    const { day30_subject, day30_body, day15_subject, day15_body, expired_subject, expired_body } = req.body;
    await pool.query(`
      INSERT INTO renewal_email_settings (user_id, day30_subject, day30_body, day15_subject, day15_body, expired_subject, expired_body)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        day30_subject=VALUES(day30_subject), day30_body=VALUES(day30_body), 
        day15_subject=VALUES(day15_subject), day15_body=VALUES(day15_body), 
        expired_subject=VALUES(expired_subject), expired_body=VALUES(expired_body)
    `, [req.user.id, day30_subject, day30_body, day15_subject, day15_body, expired_subject, expired_body]);
    res.json({ success: true });
  });

  // Product Templates
  apiRouter.get("/products/:id/template", authenticate, async (req: any, res) => {
    const [rows]: any = await pool.query("SELECT * FROM product_email_templates WHERE product_id = ?", [req.params.id]);
    res.json(rows[0] || { subject: "", body: "" });
  });

  apiRouter.post("/products/:id/template", authenticate, async (req: any, res) => {
    const { subject, body } = req.body;
    await pool.query(`
      INSERT INTO product_email_templates (product_id, subject, body)
      VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE subject=VALUES(subject), body=VALUES(body)
    `, [req.params.id, subject, body]);
    res.json({ success: true });
  });

  // Public order handling
  apiRouter.post("/public/orders", async (req, res) => {
    const { name, email, phone, product_id, amount, payment_method } = req.body;
    const [uRows]: any = await pool.query("SELECT id FROM users ORDER BY id ASC LIMIT 1");
    if (uRows.length === 0) throw new Error("No users found");
    const adminId = uRows[0].id;

    const [cRows]: any = await pool.query("SELECT id FROM customers WHERE email = ? AND user_id = ?", [email, adminId]);
    let customerId;
    if (cRows.length > 0) customerId = cRows[0].id;
    else {
      const [cRes]: any = await pool.query("INSERT INTO customers (user_id, name, email, phone, source) VALUES (?, ?, ?, ?, ?)", [adminId, name, email, phone, 'Landing Page']);
      customerId = cRes.insertId;
    }

    const [pRows]: any = await pool.query("SELECT type FROM products WHERE id = ?", [product_id]);
    if (pRows.length === 0) throw new Error("Product not found");
    
    const renewalDate = new Date();
    const type = pRows[0].type;
    if (type === '1month') renewalDate.setMonth(renewalDate.getMonth() + 1);
    else if (type === '1year') renewalDate.setFullYear(renewalDate.getFullYear() + 1);
    else renewalDate.setMonth(renewalDate.getMonth() + 1);

    const [result]: any = await pool.query(`
      INSERT INTO sales (user_id, customer_id, product_id, amount, profit, payment_method, date, renewal_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [adminId, customerId, product_id, amount, amount, payment_method, new Date(), renewalDate, 'Pending']);
    res.json({ success: true, id: result.insertId });
  });

  apiRouter.post("/public/canva-renewal/orders", async (req, res) => {
    const { name, phone, email, package_name, price, payment_method, sender_number, transaction_id } = req.body;
    const [uRows]: any = await pool.query("SELECT id FROM users ORDER BY id ASC LIMIT 1");
    if (uRows.length === 0) throw new Error("No users found");
    const adminId = uRows[0].id;

    const [result]: any = await pool.query(`
      INSERT INTO canva_renewal_orders (user_id, name, phone, email, package_name, price, payment_method, sender_number, transaction_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [adminId, name, phone, email, package_name, price, payment_method, sender_number, transaction_id, new Date()]);

    // Send order confirmation email to customer
    try {
      const [smtpRows]: any = await pool.query("SELECT * FROM smtp_settings WHERE user_id = ?", [adminId]);
      const smtp = smtpRows[0];
      if (smtp) {
        const transporter = getTransporter(smtp);
        if (transporter) {
          await transporter.sendMail({
            from: `"${smtp.from_name || 'DigiSheba'}" <${smtp.from_email || smtp.user}>`,
            to: email,
            subject: "Canva Renewal Order Received",
            text: `Hi ${name},\n\nWe have received your order for ${package_name}. Our team will process it soon (usually within 30 minutes).\n\nDetails:\nPackage: ${package_name}\nPrice: ৳${price}\nTransaction ID: ${transaction_id}\n\nThank you!`,
            html: `<h3>Order Received!</h3><p>Hi ${name},</p><p>We have received your order for <b>${package_name}</b>. Our team will process it soon (usually within 30 minutes).</p><p><b>Details:</b><br>Package: ${package_name}<br>Price: ৳${price}<br>Transaction ID: ${transaction_id}</p><p>Thank you!</p>`
          });
        }
      }
    } catch (e) {
      console.error("Public Order Email Error:", e);
    }

    res.json({ success: true, id: result.insertId });
  });

  apiRouter.get("/public/canva-renewal/settings", async (req, res) => {
    const [uRows]: any = await pool.query("SELECT user_id FROM canva_renewal_settings LIMIT 1");
    if (uRows.length === 0) return res.json({ packages: [] });
    const [sRows]: any = await pool.query("SELECT * FROM canva_renewal_settings WHERE user_id = ?", [uRows[0].user_id]);
    const s = sRows[0];
    res.json({
      packages: typeof s.packages === 'string' ? JSON.parse(s.packages || '[]') : (s.packages || []),
      payment_info: typeof s.payment_info === 'string' ? JSON.parse(s.payment_info || '{}') : (s.payment_info || {}),
      banner_url: s.banner_url,
      page_title: s.page_title,
      page_description: s.page_description,
      bkash_logo: s.bkash_logo,
      nagad_logo: s.nagad_logo,
      rocket_logo: s.rocket_logo,
      redirect_url: s.redirect_url
    });
  });

  // Global Error Handler for API
  apiRouter.use((err: any, req: any, res: any, next: any) => {
    console.error("API Error:", err);
    res.status(500).json({ error: err.message || "Internal Server Error" });
  });

  // Mount API Router
  app.use("/api", apiRouter);

  // Global Error Handler
  app.use((err: any, req: any, res: any, next: any) => {
    console.error("GLOBAL SERVER ERROR:", err);
    res.status(500).json({ 
      error: "Critical Server Error", 
      details: err.message || "Check server logs" 
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  const PORT = 3000;

  // Background task for renewal notifications
  const checkRenewals = async () => {
    console.log("Checking for upcoming renewals...");
    try {
      const now = new Date();
      
      // 1. Get all active sales that need notifications
      const [sales]: any = await pool.query(`
        SELECT s.*, c.name as customer_name, c.email as customer_email, p.name as product_name, u.id as owner_id
        FROM sales s
        JOIN customers c ON s.customer_id = c.id
        JOIN products p ON s.product_id = p.id
        JOIN users u ON s.user_id = u.id
        WHERE s.status = 'Approved' 
        AND s.renewal_date IS NOT NULL
      `);

      for (const sale of sales) {
        if (!sale.customer_email) continue;
        
        const renewalDate = new Date(sale.renewal_date);
        const diffTime = renewalDate.getTime() - now.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        let type: 'day30' | 'day15' | 'expired' | null = null;
        if (diffDays <= 0 && !sale.expired_sent) type = 'expired';
        else if (diffDays <= 15 && diffDays > 0 && !sale.day15_sent) type = 'day15';
        else if (diffDays <= 30 && diffDays > 15 && !sale.day30_sent) type = 'day30';

        if (type) {
          // Wrap in inner try-catch so one failure doesn't stop the whole task
          try {
            const [smtpRows]: any = await pool.query("SELECT * FROM smtp_settings WHERE user_id = ?", [sale.owner_id]);
            const [settRows]: any = await pool.query("SELECT * FROM renewal_email_settings WHERE user_id = ?", [sale.owner_id]);
            const smtp = smtpRows[0];
            const settings = settRows[0];

            if (smtp && settings) {
              const subjectTemplate = settings[`${type}_subject`];
              const bodyTemplate = settings[`${type}_body`];

              if (subjectTemplate && bodyTemplate) {
                const transporter = getTransporter(smtp);
                if (!transporter) continue;

                const adminName = smtp.from_name || "Admin";
                const renewalDateStr = sale.renewal_date ? new Date(sale.renewal_date).toLocaleDateString() : "N/A";
                
                const replacements: any = {
                  '{customer_name}': sale.customer_name || 'Customer',
                  '{name}': sale.customer_name || 'Customer',
                  '{product_name}': sale.product_name,
                  '{product}': sale.product_name,
                  '{renewal_date}': renewalDateStr,
                  '{admin_name}': adminName,
                  '{{customer_name}}': sale.customer_name || 'Customer',
                  '{{product_name}}': sale.product_name,
                  '{{renewal_date}}': renewalDateStr
                };

                let subject = subjectTemplate;
                let body = bodyTemplate;

                Object.keys(replacements).forEach(key => {
                  const regex = new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                  subject = subject.replace(regex, replacements[key]);
                  body = body.replace(regex, replacements[key]);
                });

                await transporter.sendMail({
                  from: `"${adminName}" <${smtp.from_email || smtp.user}>`,
                  to: sale.customer_email,
                  subject: subject,
                  text: body,
                  html: body.replace(/\n/g, "<br>"),
                });
                
                // Mark as sent
                await pool.query(`UPDATE sales SET ${type}_sent = 1 WHERE id = ?`, [sale.id]);
                console.log(`Renewal email (${type}) sent to ${sale.customer_email}`);
              }
            }
          } catch (innerErr) {
            console.error(`Error processing renewal for sale ID ${sale.id}:`, innerErr);
          }
        }
      }
    } catch (e) {
      console.error("Renewal background task failed:", e);
    }
  };

  // Run immediately on start then every 24 hours
  checkRenewals().catch(console.error);
  setInterval(() => checkRenewals().catch(console.error), 24 * 60 * 60 * 1000);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
