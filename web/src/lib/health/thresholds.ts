export interface HostThresholds {
  cpu_warning_percent: number;
  cpu_critical_percent: number;
  cpu_sustained_seconds: number;
  memory_available_warning_percent: number;
  memory_available_critical_percent: number;
  swap_warning_percent: number;
  swap_critical_percent: number;
  iowait_warning_percent: number;
  iowait_critical_percent: number;
  load_warning_ratio: number;
  load_critical_ratio: number;
  cpu_temp_warning: number;
  cpu_temp_critical: number;
  recent_boot_seconds: number;
}

export interface StorageThresholds {
  warning_percent: number;
  high_percent: number;
  critical_percent: number;
  inode_warning_percent: number;
  forecast_warning_days: number;
  forecast_critical_days: number;
  min_forecast_history_days: number;
  min_forecast_r_squared: number;
}

export interface DiskThresholds {
  temp_warning: number;
  temp_critical: number;
  temp_watch: number;
  pending_sectors_critical: number;
  offline_uncorrectable_critical: number;
  crc_delta_warning: number;
  crc_delta_critical: number;
  reallocated_delta_warning: number;
  command_timeout_delta_warning: number;
}

export interface NetworkThresholds {
  latency_warning_ms: number;
  latency_critical_ms: number;
  packet_loss_warning_percent: number;
  packet_loss_critical_percent: number;
  internet_down_seconds: number;
  gateway_cpu_warning: number;
  gateway_memory_warning: number;
}

export interface ContainerThresholds {
  restart_delta_warning: number;
  restart_delta_critical: number;
  recent_start_seconds: number;
  memory_percent_warning: number;
}

export interface BackupThresholds {
  warning_days: number;
  critical_days: number;
  destination_full_percent: number;
  shrink_warning_percent: number;
}

export interface ProbeThresholds {
  latency_warning_ms: number;
  latency_critical_ms: number;
  tls_expiry_warning_days: number;
  tls_expiry_high_days: number;
  tls_expiry_critical_days: number;
}

export interface FreshnessThresholds {
  default_seconds: number;
  prometheus_seconds: number;
  local_seconds: number;
  probe_seconds: number;
  smart_seconds: number;
}

export interface Thresholds {
  host: HostThresholds;
  storage: StorageThresholds;
  disk: DiskThresholds;
  network: NetworkThresholds;
  container: ContainerThresholds;
  backup: BackupThresholds;
  probe: ProbeThresholds;
  freshness: FreshnessThresholds;
}

function envInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (val === undefined || val === null || val.trim() === "") {
    return defaultValue;
  }
  const parsed = parseInt(val.trim(), 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function envFloat(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (val === undefined || val === null || val.trim() === "") {
    return defaultValue;
  }
  const parsed = parseFloat(val.trim());
  return isNaN(parsed) ? defaultValue : parsed;
}

export function getDefaultThresholds(): Thresholds {
  return {
    host: {
      cpu_warning_percent: envFloat("TH_CPU_WARNING", 90.0),
      cpu_critical_percent: envFloat("TH_CPU_CRITICAL", 97.0),
      cpu_sustained_seconds: envInt("TH_CPU_SUSTAINED", 600),
      memory_available_warning_percent: envFloat("TH_MEM_AVAIL_WARNING", 10.0),
      memory_available_critical_percent: envFloat("TH_MEM_AVAIL_CRITICAL", 5.0),
      swap_warning_percent: envFloat("TH_SWAP_WARNING", 50.0),
      swap_critical_percent: envFloat("TH_SWAP_CRITICAL", 80.0),
      iowait_warning_percent: envFloat("TH_IOWAIT_WARNING", 20.0),
      iowait_critical_percent: envFloat("TH_IOWAIT_CRITICAL", 40.0),
      load_warning_ratio: envFloat("TH_LOAD_WARNING_RATIO", 1.0),
      load_critical_ratio: envFloat("TH_LOAD_CRITICAL_RATIO", 2.0),
      cpu_temp_warning: envFloat("TH_CPU_TEMP_WARNING", 80.0),
      cpu_temp_critical: envFloat("TH_CPU_TEMP_CRITICAL", 90.0),
      recent_boot_seconds: envInt("TH_RECENT_BOOT", 1800),
    },
    storage: {
      warning_percent: envFloat("TH_FS_WARNING", 80.0),
      high_percent: envFloat("TH_FS_HIGH", 90.0),
      critical_percent: envFloat("TH_FS_CRITICAL", 95.0),
      inode_warning_percent: envFloat("TH_INODE_WARNING", 80.0),
      forecast_warning_days: envFloat("TH_FORECAST_WARNING_DAYS", 90.0),
      forecast_critical_days: envFloat("TH_FORECAST_CRITICAL_DAYS", 30.0),
      min_forecast_history_days: envFloat("TH_MIN_FORECAST_DAYS", 3.0),
      min_forecast_r_squared: envFloat("TH_MIN_FORECAST_R2", 0.5),
    },
    disk: {
      temp_warning: envFloat("TH_DISK_TEMP_WARNING", 50.0),
      temp_critical: envFloat("TH_DISK_TEMP_CRITICAL", 55.0),
      temp_watch: envFloat("TH_DISK_TEMP_WATCH", 45.0),
      pending_sectors_critical: envInt("TH_PENDING_SECTORS", 0),
      offline_uncorrectable_critical: envInt("TH_OFFLINE_UNCORRECTABLE", 0),
      crc_delta_warning: envInt("TH_CRC_DELTA_WARNING", 1),
      crc_delta_critical: envInt("TH_CRC_DELTA_CRITICAL", 50),
      reallocated_delta_warning: envInt("TH_REALLOC_DELTA_WARNING", 1),
      command_timeout_delta_warning: envInt("TH_CMD_TIMEOUT_DELTA", 1),
    },
    network: {
      latency_warning_ms: envFloat("TH_LATENCY_WARNING", 100.0),
      latency_critical_ms: envFloat("TH_LATENCY_CRITICAL", 250.0),
      packet_loss_warning_percent: envFloat("TH_LOSS_WARNING", 5.0),
      packet_loss_critical_percent: envFloat("TH_LOSS_CRITICAL", 15.0),
      internet_down_seconds: envInt("TH_INTERNET_DOWN", 120),
      gateway_cpu_warning: envFloat("TH_GW_CPU_WARNING", 85.0),
      gateway_memory_warning: envFloat("TH_GW_MEM_WARNING", 90.0),
    },
    container: {
      restart_delta_warning: envInt("TH_RESTART_DELTA_WARNING", 1),
      restart_delta_critical: envInt("TH_RESTART_DELTA_CRITICAL", 3),
      recent_start_seconds: envInt("TH_RECENT_START", 900),
      memory_percent_warning: envFloat("TH_CONTAINER_MEM_WARNING", 90.0),
    },
    backup: {
      warning_days: envFloat("TH_BACKUP_WARNING_DAYS", 4.0),
      critical_days: envFloat("TH_BACKUP_CRITICAL_DAYS", 7.0),
      destination_full_percent: envFloat("TH_BACKUP_DEST_FULL", 90.0),
      shrink_warning_percent: envFloat("TH_BACKUP_SHRINK", 25.0),
    },
    probe: {
      latency_warning_ms: envFloat("TH_PROBE_LATENCY_WARNING", 2000.0),
      latency_critical_ms: envFloat("TH_PROBE_LATENCY_CRITICAL", 5000.0),
      tls_expiry_warning_days: envFloat("TH_TLS_WARNING_DAYS", 30.0),
      tls_expiry_high_days: envFloat("TH_TLS_HIGH_DAYS", 14.0),
      tls_expiry_critical_days: envFloat("TH_TLS_CRITICAL_DAYS", 7.0),
    },
    freshness: {
      default_seconds: envInt("TH_STALE_DEFAULT", 180),
      prometheus_seconds: envInt("TH_STALE_PROMETHEUS", 180),
      local_seconds: envInt("TH_STALE_LOCAL", 120),
      probe_seconds: envInt("TH_STALE_PROBE", 300),
      smart_seconds: envInt("TH_STALE_SMART", 3600),
    }
  };
}

let _THRESHOLDS: Thresholds | null = null;

export function getThresholds(): Thresholds {
  if (!_THRESHOLDS) {
    _THRESHOLDS = getDefaultThresholds();
  }
  return _THRESHOLDS;
}

export const COMPONENT_WEIGHTS: Record<string, number> = {
  raid_disks: envFloat("WEIGHT_RAID", 25.0),
  server: envFloat("WEIGHT_SERVER", 15.0),
  network: envFloat("WEIGHT_NETWORK", 15.0),
  vpn: envFloat("WEIGHT_VPN", 10.0),
  storage: envFloat("WEIGHT_STORAGE", 10.0),
  applications: envFloat("WEIGHT_APPLICATIONS", 10.0),
  backups: envFloat("WEIGHT_BACKUPS", 10.0),
  security: envFloat("WEIGHT_SECURITY", 5.0),
  conditions: envFloat("WEIGHT_CONDITIONS", 5.0),
};
