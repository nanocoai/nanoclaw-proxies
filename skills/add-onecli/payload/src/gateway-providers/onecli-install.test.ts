import { describe, expect, it } from 'vitest';

import { withLinuxHostGateway } from '../../.claude/skills/add-onecli/scripts/setup.js';

const compose = `services:
  onecli:
    image: onecli
    container_name: onecli
    restart: unless-stopped
`;

describe('OneCLI compose setup', () => {
  it('adds the Linux host gateway once', () => {
    const configured = withLinuxHostGateway(compose, 'linux');
    expect(configured).toContain('extra_hosts:\n      - "host.docker.internal:host-gateway"');
    expect(withLinuxHostGateway(configured, 'linux')).toBe(configured);
    expect(withLinuxHostGateway(compose, 'darwin')).toBe(compose);
  });
});
