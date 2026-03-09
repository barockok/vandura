#!/usr/bin/env tsx
/**
 * Seed Elasticsearch with realistic sample data
 * Creates indices with mappings and populates with sample documents
 */

import { Client } from "@elastic/elasticsearch";

const ES_URL = process.env.ELASTICSEARCH_URL || "http://localhost:9200";

const client = new Client({
  node: ES_URL,
  requestTimeout: 30000,
});

// Application logs index mapping
const logsMapping = {
  mappings: {
    properties: {
      timestamp: { type: "date" },
      level: { type: "keyword" },
      service: { type: "keyword" },
      message: { type: "text" },
      trace_id: { type: "keyword" },
      user_id: { type: "keyword" },
      duration_ms: { type: "integer" },
      status_code: { type: "integer" },
      host: { type: "keyword" },
      environment: { type: "keyword" },
    },
  },
};

// User sessions index mapping
const sessionsMapping = {
  mappings: {
    properties: {
      session_id: { type: "keyword" },
      user_id: { type: "keyword" },
      started_at: { type: "date" },
      ended_at: { type: "date" },
      duration_seconds: { type: "long" },
      actions_count: { type: "integer" },
      status: { type: "keyword" },
      client_ip: { type: "ip" },
      user_agent: { type: "text" },
      country: { type: "keyword" },
    },
  },
};

// Metrics index mapping
const metricsMapping = {
  mappings: {
    properties: {
      timestamp: { type: "date" },
      metric_name: { type: "keyword" },
      value: { type: "float" },
      unit: { type: "keyword" },
      service: { type: "keyword" },
      host: { type: "keyword" },
      tags: { type: "keyword" },
    },
  },
};

const sampleLogs = [
  { level: "INFO", service: "api-gateway", message: "Request processed successfully", status_code: 200 },
  { level: "INFO", service: "api-gateway", message: "User authenticated via OAuth", status_code: 200 },
  { level: "DEBUG", service: "auth-service", message: "Token validation successful", status_code: 200 },
  { level: "WARN", service: "database", message: "Slow query detected", status_code: 200 },
  { level: "ERROR", service: "payment-service", message: "Payment gateway timeout", status_code: 504 },
  { level: "INFO", service: "notification-service", message: "Email sent successfully", status_code: 200 },
  { level: "ERROR", service: "api-gateway", message: "Rate limit exceeded", status_code: 429 },
  { level: "INFO", service: "user-service", message: "Profile updated", status_code: 200 },
  { level: "WARN", service: "cache", message: "Cache miss for key", status_code: 200 },
  { level: "INFO", service: "search-service", message: "Index refreshed", status_code: 200 },
  { level: "DEBUG", service: "api-gateway", message: "Request headers validated", status_code: 200 },
  { level: "ERROR", service: "file-service", message: "File upload failed - size exceeded", status_code: 413 },
  { level: "INFO", service: "audit-service", message: "Audit log created", status_code: 200 },
  { level: "WARN", service: "api-gateway", message: "Deprecated endpoint accessed", status_code: 200 },
  { level: "INFO", service: "scheduler", message: "Cron job completed", status_code: 200 },
];

const sampleCountries = ["US", "UK", "DE", "FR", "JP", "AU", "CA", "BR", "IN", "SG"];
const sampleStatuses = ["completed", "active", "expired", "terminated"];
const sampleUserAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/119.0.0.0",
];

const sampleMetrics = [
  { metric_name: "cpu_usage", unit: "percent", tags: ["system", "performance"] },
  { metric_name: "memory_usage", unit: "bytes", tags: ["system", "memory"] },
  { metric_name: "request_latency", unit: "milliseconds", tags: ["api", "performance"] },
  { metric_name: "error_rate", unit: "percent", tags: ["api", "reliability"] },
  { metric_name: "active_connections", unit: "count", tags: ["network", "connections"] },
  { metric_name: "disk_io", unit: "bytes_per_sec", tags: ["disk", "io"] },
];

function generateLogs(count: number) {
  const logs = [];
  const hosts = ["prod-api-01", "prod-api-02", "prod-worker-01", "prod-db-01"];
  const envs = ["production", "production", "production", "staging"];

  for (let i = 0; i < count; i++) {
    const template = sampleLogs[Math.floor(Math.random() * sampleLogs.length)];
    const now = Date.now();
    const timestamp = new Date(now - Math.floor(Math.random() * 7 * 24 * 60 * 60 * 1000)); // Last 7 days

    logs.push({
      index: { _index: "application-logs" },
    });
    logs.push({
      timestamp: timestamp.toISOString(),
      level: template.level,
      service: template.service,
      message: `${template.message} - request_id: ${Math.random().toString(36).substring(7)}`,
      trace_id: `trace-${Math.random().toString(36).substring(2, 14)}`,
      user_id: `user_${Math.floor(Math.random() * 1000)}`,
      duration_ms: Math.floor(Math.random() * 500) + 10,
      status_code: template.status_code,
      host: hosts[Math.floor(Math.random() * hosts.length)],
      environment: envs[Math.floor(Math.random() * envs.length)],
    });
  }
  return logs;
}

function generateSessions(count: number) {
  const sessions = [];

  for (let i = 0; i < count; i++) {
    const started = Date.now() - Math.floor(Math.random() * 30 * 24 * 60 * 60 * 1000); // Last 30 days
    const duration = Math.floor(Math.random() * 3600) + 60;
    const ended = started + duration * 1000;

    sessions.push({
      index: { _index: "user-sessions" },
    });
    sessions.push({
      session_id: `sess_${Math.random().toString(36).substring(2, 14)}`,
      user_id: `user_${Math.floor(Math.random() * 500)}`,
      started_at: new Date(started).toISOString(),
      ended_at: new Date(ended).toISOString(),
      duration_seconds: duration,
      actions_count: Math.floor(Math.random() * 50) + 1,
      status: sampleStatuses[Math.floor(Math.random() * sampleStatuses.length)],
      client_ip: `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
      user_agent: sampleUserAgents[Math.floor(Math.random() * sampleUserAgents.length)],
      country: sampleCountries[Math.floor(Math.random() * sampleCountries.length)],
    });
  }
  return sessions;
}

function generateMetrics(count: number) {
  const metrics = [];
  const hosts = ["prod-api-01", "prod-api-02", "prod-worker-01", "prod-db-01"];

  for (let i = 0; i < count; i++) {
    const template = sampleMetrics[Math.floor(Math.random() * sampleMetrics.length)];
    const timestamp = new Date(Date.now() - Math.floor(Math.random() * 24 * 60 * 60 * 1000)); // Last 24 hours

    let value: number;
    switch (template.metric_name) {
      case "cpu_usage":
        value = Math.random() * 80 + 10;
        break;
      case "memory_usage":
        value = Math.random() * 8 * 1024 * 1024 * 1024 + 1024 * 1024 * 1024;
        break;
      case "request_latency":
        value = Math.random() * 200 + 10;
        break;
      case "error_rate":
        value = Math.random() * 5;
        break;
      case "active_connections":
        value = Math.floor(Math.random() * 500) + 50;
        break;
      case "disk_io":
        value = Math.random() * 100 * 1024 * 1024;
        break;
      default:
        value = Math.random() * 100;
    }

    metrics.push({
      index: { _index: "system-metrics" },
    });
    metrics.push({
      timestamp: timestamp.toISOString(),
      metric_name: template.metric_name,
      value: Math.round(value * 100) / 100,
      unit: template.unit,
      service: "vandura",
      host: hosts[Math.floor(Math.random() * hosts.length)],
      tags: template.tags,
    });
  }
  return metrics;
}

async function seedElasticsearch() {
  console.log("Seeding Elasticsearch at", ES_URL);

  try {
    // Check connection
    const health = await client.cluster.health();
    console.log("Cluster status:", health.status);

    // Create indices with mappings
    console.log("\nCreating indices...");

    const indices = await client.cat.indices({ format: "json" });
    const existingIndices = indices.body.map((i: any) => i.index);

    if (!existingIndices.includes("application-logs")) {
      await client.indices.create({
        index: "application-logs",
        body: logsMapping as any,
      });
      console.log("  Created: application-logs");
    }

    if (!existingIndices.includes("user-sessions")) {
      await client.indices.create({
        index: "user-sessions",
        body: sessionsMapping as any,
      });
      console.log("  Created: user-sessions");
    }

    if (!existingIndices.includes("system-metrics")) {
      await client.indices.create({
        index: "system-metrics",
        body: metricsMapping as any,
      });
      console.log("  Created: system-metrics");
    }

    // Bulk insert logs
    console.log("\nInserting sample data...");

    const logDocs = generateLogs(500);
    await client.bulk({ body: logDocs as any });
    console.log("  Inserted 500 application logs");

    const sessionDocs = generateSessions(200);
    await client.bulk({ body: sessionDocs as any });
    console.log("  Inserted 200 user sessions");

    const metricDocs = generateMetrics(300);
    await client.bulk({ body: metricDocs as any });
    console.log("  Inserted 300 system metrics");

    // Refresh indices
    await client.indices.refresh({ index: ["application-logs", "user-sessions", "system-metrics"] });

    // Show counts
    console.log("\nDocument counts:");
    const logCount = await client.count({ index: "application-logs" });
    const sessionCount = await client.count({ index: "user-sessions" });
    const metricCount = await client.count({ index: "system-metrics" });

    console.log(`  application-logs: ${logCount.body.count}`);
    console.log(`  user-sessions: ${sessionCount.body.count}`);
    console.log(`  system-metrics: ${metricCount.body.count}`);

    console.log("\nSeeding completed successfully!");
  } catch (error: any) {
    console.error("Error seeding Elasticsearch:", error.message);
    if (error.code === "ECONNREFUSED") {
      console.error("\nMake sure Elasticsearch is running: docker-compose up -d elasticsearch");
    }
    process.exit(1);
  } finally {
    await client.close();
  }
}

seedElasticsearch();
