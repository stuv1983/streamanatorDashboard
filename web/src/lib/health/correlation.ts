import { Alert, Status } from '../status';

export interface CausalRule {
    causeKey: string;
    effectPrefixes: string[];
    incidentTitle: string;
    explanation: string;
}

export const CAUSAL_RULES: CausalRule[] = [
    {
        causeKey: "vpn.gluetun",
        effectPrefixes: [
            "probe.sabnzbd",
            "probe.sonarr",
            "probe.radarr",
            "probe.prowlarr",
            "probe.qbittorrent",
            "container.media-vpn",
            "app.sabnzbd",
            "app.sonarr",
            "app.radarr",
            "app.prowlarr",
            "app.qbittorrent",
            "vpn.leak",
        ],
        incidentTitle: "Media VPN stack connectivity failure",
        explanation:
            "Every container in the media stack shares Gluetun's network " +
            "namespace, so when Gluetun loses its tunnel they all lose DNS and " +
            "outbound connectivity simultaneously.",
    },
    {
        causeKey: "network.internet",
        effectPrefixes: ["vpn.", "probe.", "app.", "backup.destination"],
        incidentTitle: "Internet connectivity failure",
        explanation:
            "With the WAN down, the VPN tunnel and every outbound probe fail as " +
            "a consequence rather than independently.",
    },
    {
        causeKey: "raid.md127",
        effectPrefixes: ["storage./mnt/media", "disk.io.md127", "app.plex", "app.immich"],
        incidentTitle: "RAID array fault affecting media storage",
        explanation:
            "/mnt/media lives on md127, so an array fault propagates to the " +
            "filesystem and to every service reading from it.",
    },
    {
        causeKey: "server.docker",
        effectPrefixes: ["container.", "vpn.", "app."],
        incidentTitle: "Docker daemon unavailable",
        explanation:
            "No container state can be read while the daemon is down, so all " +
            "container-derived alerts are consequences of this one.",
    },
];

export class Incident {
    cause: Alert;
    effects: Alert[];
    title: string;
    explanation: string;

    constructor(cause: Alert, effects: Alert[] = [], title: string = "", explanation: string = "") {
        this.cause = cause;
        this.effects = effects;
        this.title = title;
        this.explanation = explanation;
    }

    get status(): Status {
        return this.cause.status;
    }

    get isCorrelated(): boolean {
        return this.effects.length > 0;
    }
}

export function correlate(alerts: Alert[]): [Incident[], Alert[]] {
    const byKey = new Map<string, Alert>();
    for (const alert of alerts) {
        byKey.set(alert.key, alert);
    }
    
    const claimed = new Set<string>();
    const incidents: Incident[] = [];

    for (const rule of CAUSAL_RULES) {
        const cause = byKey.get(rule.causeKey);
        if (!cause || (cause.status !== Status.CRITICAL && cause.status !== Status.WARNING)) {
            continue;
        }
        if (claimed.has(cause.key)) {
            continue;
        }

        const effects = alerts.filter(alert => 
            alert.key !== cause.key &&
            !claimed.has(alert.key) &&
            (alert.status === Status.CRITICAL || alert.status === Status.WARNING || alert.status === Status.UNKNOWN) &&
            rule.effectPrefixes.some(prefix => alert.key.startsWith(prefix))
        );

        if (effects.length === 0) {
            continue;
        }

        for (const effect of effects) {
            effect.caused_by = cause.key;
            claimed.add(effect.key);
        }
        cause.effects = effects.map(e => e.key);
        claimed.add(cause.key);

        incidents.push(
            new Incident(cause, effects, rule.incidentTitle, rule.explanation)
        );
    }

    const uncorrelated = alerts.filter(alert => !claimed.has(alert.key));
    return [incidents, uncorrelated];
}

export function probableCauseForDiskCrc(): [string, string] {
    const cause =
        "UDMA CRC errors are checksum failures on the SATA link itself, not bad " +
        "sectors. Usual culprits, in order of likelihood: SATA data cable, " +
        "connector seating, backplane, controller port, power stability.";
    const action =
        "Inspect and reseat the physical data path before replacing the disk. " +
        "Note which cable and port the serial is on, swap the cable, then watch " +
        "whether the delta returns to zero.";
    return [cause, action];
}

export function summariseIncident(incident: Incident): string {
    const effectList = incident.effects.slice(0, 5).map(e => e.title).join(", ");
    const extra = incident.effects.length <= 5 ? "" : ` (+${incident.effects.length - 5} more)`;
    return `${incident.explanation} Primary cause: ${incident.cause.title}. Effects: ${effectList}${extra}.`;
}
