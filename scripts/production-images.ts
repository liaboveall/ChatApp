/** Exact indexes. The release archive also saves native IDs for offline recovery. */
export const PRODUCTION_DEPENDENCIES = {
  valkey:
    'valkey/valkey:9.1-alpine@sha256:bf09d58e96d6b4524a15396b65b242bbe18beebbcc15a04d8ee75ddac62fae0b',
  garage:
    'dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020',
} as const
export const PRODUCTION_BUILD_IMAGES = ['server', 'media', 'ops', 'postgres', 'nginx'] as const
