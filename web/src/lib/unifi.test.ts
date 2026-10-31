import test from "node:test";
import assert from "node:assert/strict";
import { availability, getVlanStats } from "./unifi";

test("snake_case settings from config enable the Integration API", () => {
  const result = availability({ controller_url: "https://10.0.0.1", api_key: "secret", verify_tls: false });
  assert.equal(result.configured, true);
  assert.equal(result.source, "UniFi Network Integration API");
});

test("configured VLAN ids survive the config-to-collector boundary", async () => {
  const rows = await getVlanStats({}, [{ vlan_id: 40, name: "Media", subnet: "10.0.40.0/24" } as never]);
  assert.equal(rows[0].vlanId, 40);
  assert.equal(rows[0].name, "Media");
});
