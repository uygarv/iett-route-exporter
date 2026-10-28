module.exports = {
  apps: [
    {
      name: "iett-route-exporter",
      script: "src/server.js",
      instances: 1,
      exec_mode: "fork"
    },
    {
      name: "iett-history-worker",
      script: "src/history/worker.js",
      instances: 1,
      exec_mode: "fork",
      kill_timeout: 30000,
      exp_backoff_restart_delay: 1000,
      max_memory_restart: "1G"
    }
  ]
};
