import type {
  InvocationContext,
  RuntimeCatalogEntry,
  RuntimeCatalogProvider,
} from '@marshal/agent-runtime-core';
import type { RuntimeCompositionRegistrySnapshot } from '@marshal/agent-runtime-composer';
import { appServicePublicNames } from '@marshal/agent-runtime-typescript';
import type {
  RuntimeResourceContent,
  RuntimeResourceDescriptor,
  RuntimeScopedResourcePort,
} from './types.js';

export type RuntimeCompositionHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface RuntimeCompositionIdentity {
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly type?: string;
  readonly packageLocation?: string;
}

export interface RuntimeCompositionServiceSnapshot extends RuntimeCompositionIdentity {
  readonly publicName?: string;
  readonly declaration?: string;
  readonly methods?: Readonly<Record<string, unknown>>;
  readonly contractId?: string;
  readonly selectedProvider?: string;
  readonly alternativeProviders?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly conflicts?: readonly string[];
}

export interface RuntimeCompositionContractSnapshot extends RuntimeCompositionIdentity {
  readonly publicName?: string;
  readonly declaration?: string;
  readonly methods?: Readonly<Record<string, unknown>>;
  readonly dependencies?: readonly string[];
  readonly conflicts?: readonly string[];
}

export interface RuntimeCompositionProviderSnapshot extends RuntimeCompositionIdentity {
  readonly publicName?: string;
  readonly serviceId?: string;
  readonly contractId?: string;
  readonly selected?: boolean;
  readonly health?: RuntimeCompositionHealth;
  readonly dependencies?: readonly string[];
  readonly conflicts?: readonly string[];
}

export interface RuntimeCompositionExtensionSnapshot extends RuntimeCompositionIdentity {
  readonly services?: readonly RuntimeCompositionServiceSnapshot[];
  readonly contracts?: readonly RuntimeCompositionContractSnapshot[];
  readonly providers?: readonly RuntimeCompositionProviderSnapshot[];
  readonly selectedProviders?: readonly string[];
  readonly alternativeProviders?: readonly string[];
  readonly health?: RuntimeCompositionHealth;
  readonly dependencies?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly docs?: readonly string[];
  readonly resources?: readonly string[];
  readonly examples?: readonly string[];
}

export interface RuntimeCompositionSnapshot {
  readonly id: string;
  readonly name?: string;
  readonly version?: string;
  readonly description?: string;
  readonly type?: string;
  readonly packageLocation?: string;
  readonly extensions?: readonly RuntimeCompositionExtensionSnapshot[];
  readonly services?: readonly RuntimeCompositionServiceSnapshot[];
  readonly contracts?: readonly RuntimeCompositionContractSnapshot[];
  readonly providers?: readonly RuntimeCompositionProviderSnapshot[];
  readonly selectedProviders?: readonly string[];
  readonly alternativeProviders?: readonly string[];
  readonly health?: RuntimeCompositionHealth;
  readonly dependencies?: readonly string[];
  readonly conflicts?: readonly string[];
  readonly docs?: readonly string[];
  readonly resources?: readonly string[];
  readonly examples?: readonly string[];
  readonly appServicesSnippet?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RuntimeCompositionCatalogDocument {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly type: string;
  readonly packageLocation: string | null;
  readonly extensions: readonly RuntimeCompositionExtensionSnapshot[];
  readonly services: readonly RuntimeCompositionServiceSnapshot[];
  readonly contracts: readonly RuntimeCompositionContractSnapshot[];
  readonly providers: readonly RuntimeCompositionProviderSnapshot[];
  readonly selectedProviders: readonly string[];
  readonly alternativeProviders: readonly string[];
  readonly health: RuntimeCompositionHealth;
  readonly dependencies: readonly string[];
  readonly conflicts: readonly string[];
  readonly docs: readonly string[];
  readonly resources: readonly string[];
  readonly examples: readonly string[];
  readonly appServicesSnippet: string;
}

export type RuntimeCompositionSnapshotSource =
  | RuntimeCompositionSnapshot
  | (() => RuntimeCompositionSnapshot | Promise<RuntimeCompositionSnapshot>);

export function toRuntimeCompositionSnapshot(
  snapshot: RuntimeCompositionRegistrySnapshot,
): RuntimeCompositionSnapshot {
  const publicNames = appServicePublicNames(snapshot.services.map(({ service }) => ({
    name: service.contract.name,
    token: service.key,
    ...(service.publicName === undefined ? {} : { publicName: service.publicName }),
  })));
  const contracts = snapshot.services.map(({ service }) => ({
    id: service.contract.name,
    name: service.contract.name,
    publicName: publicNames.get(service.key),
    version: service.contract.version,
    ...(service.contract.declaration === undefined ? {} : { declaration: service.contract.declaration }),
    type: 'contract',
    methods: Object.fromEntries(service.contract.methods.map((method) => [
      method.name,
      {
        ...(method.input === undefined ? {} : { input: method.input }),
        ...(method.output === undefined ? {} : { output: method.output }),
        ...(method.version === undefined ? {} : { version: method.version }),
        ...(method.description === undefined ? {} : { description: method.description }),
        ...(method.links === undefined ? {} : { links: method.links }),
        ...(method.examples === undefined ? {} : { examples: method.examples }),
      },
    ])),
  }));
  const services = snapshot.services.map((inspection) => ({
    id: inspection.service.key,
    name: inspection.service.contract.name,
    publicName: publicNames.get(inspection.service.key),
    version: inspection.service.contract.version,
    ...(inspection.service.contract.declaration === undefined ? {} : { declaration: inspection.service.contract.declaration }),
    type: 'service',
    contractId: inspection.service.contract.name,
    selectedProvider: inspection.selectedProviderId,
    alternativeProviders: inspection.providers
      .filter((provider) => provider.provider.id !== inspection.selectedProviderId)
      .map((provider) => provider.provider.id),
    methods: Object.fromEntries(inspection.service.contract.methods.map((method) => [
      method.name,
      {
        ...(method.input === undefined ? {} : { input: method.input }),
        ...(method.output === undefined ? {} : { output: method.output }),
        ...(method.version === undefined ? {} : { version: method.version }),
        ...(method.description === undefined ? {} : { description: method.description }),
        ...(method.links === undefined ? {} : { links: method.links }),
        ...(method.examples === undefined ? {} : { examples: method.examples }),
      },
    ])),
  }));
  const providers = snapshot.services.flatMap((inspection) =>
    inspection.providers.map((provider) => ({
      id: provider.provider.id,
      name: provider.provider.contract.name,
      publicName: publicNames.get(inspection.service.key),
      version: provider.provider.contract.version,
      type: 'provider',
      serviceId: inspection.service.key,
      contractId: provider.provider.contract.name,
      selected: provider.provider.id === inspection.selectedProviderId,
      health: provider.status === 'incompatible' ? 'unhealthy' as const : 'unknown' as const,
      methods: Object.fromEntries(provider.provider.contract.methods.map((method) => [
        method.name,
        {
          ...(method.input === undefined ? {} : { input: method.input }),
          ...(method.output === undefined ? {} : { output: method.output }),
          ...(method.version === undefined ? {} : { version: method.version }),
          ...(method.description === undefined ? {} : { description: method.description }),
          ...(method.links === undefined ? {} : { links: method.links }),
          ...(method.examples === undefined ? {} : { examples: method.examples }),
        },
      ])),
      metadata: provider.provider.metadata,
    })));
  return {
    id: 'runtime-composition',
    name: 'Runtime composition',
    type: 'composition',
    services,
    contracts,
    providers,
    selectedProviders: snapshot.services
      .flatMap((inspection) => inspection.selectedProviderId ? [inspection.selectedProviderId] : []),
    alternativeProviders: providers
      .filter((provider) => !provider.selected)
      .map((provider) => provider.id),
    health: providers.some((provider) => provider.health === 'unhealthy') ? 'degraded' : 'healthy',
    metadata: { overrides: snapshot.overrides },
  };
}

const PROVIDER_ID = 'marshal.runtime-composition-catalog';
const COMPOSITION_RESOURCE_URI_PREFIX = 'runtime://composition/';

/** Projects a live composition snapshot into the runtime catalog/search plane. */
export function createRuntimeCompositionCatalogProvider(
  source: RuntimeCompositionSnapshotSource,
): RuntimeCatalogProvider {
  return {
    id: PROVIDER_ID,
    async list(context) {
      return [toRuntimeCompositionCatalogEntry(await readSnapshot(source, context))];
    },
    async get(id, context) {
      const snapshot = await readSnapshot(source, context);
      const entry = toRuntimeCompositionCatalogEntry(snapshot);
      return id === entry.id ? entry : undefined;
    },
  };
}

/** Exposes the same live composition snapshot used by the catalog provider. */
export function createRuntimeCompositionResourcePort(
  source: RuntimeCompositionSnapshotSource,
): RuntimeScopedResourcePort {
  return {
    async listResources(context): Promise<readonly RuntimeResourceDescriptor[]> {
      const document = toRuntimeCompositionCatalogDocument(await readSnapshot(source, context));
      return [{
        uri: compositionResourceUri(document.id),
        name: document.title,
        description: document.description,
        mimeType: 'application/json',
        catalog: {
          owner: { type: 'catalog_provider', id: PROVIDER_ID },
          metadata: { compositionId: document.id },
        },
      }];
    },
    async readResource(uri, context): Promise<RuntimeResourceContent> {
      const document = toRuntimeCompositionCatalogDocument(await readSnapshot(source, context));
      const expectedUri = compositionResourceUri(document.id);
      if (uri !== expectedUri) throw new Error(`Runtime composition resource not found: ${uri}`);
      return {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(document, null, 2),
      };
    },
  };
}

export function toRuntimeCompositionCatalogDocument(
  snapshot: RuntimeCompositionSnapshot,
): RuntimeCompositionCatalogDocument {
  const extensions = snapshot.extensions ?? [];
  const services = [...(snapshot.services ?? []), ...extensions.flatMap((extension) => extension.services ?? [])];
  const contracts = [...(snapshot.contracts ?? []), ...extensions.flatMap((extension) => extension.contracts ?? [])];
  const providers = [...(snapshot.providers ?? []), ...extensions.flatMap((extension) => extension.providers ?? [])];
  const selectedProviders = unique([
    ...(snapshot.selectedProviders ?? []),
    ...extensions.flatMap((extension) => extension.selectedProviders ?? []),
    ...services.flatMap((service) => service.selectedProvider ? [service.selectedProvider] : []),
    ...providers.filter((provider) => provider.selected).map((provider) => provider.id),
  ]);
  const alternativeProviders = unique([
    ...(snapshot.alternativeProviders ?? []),
    ...extensions.flatMap((extension) => extension.alternativeProviders ?? []),
    ...services.flatMap((service) => service.alternativeProviders ?? []),
    ...providers.filter((provider) => !provider.selected).map((provider) => provider.id),
  ]);
  return Object.freeze({
    id: requireText(snapshot.id, 'composition id'),
    title: snapshot.name?.trim() || snapshot.id,
    description: snapshot.description?.trim() || `Runtime composition ${snapshot.id}.`,
    type: snapshot.type?.trim() || 'composition',
    packageLocation: snapshot.packageLocation?.trim() || null,
    extensions: freezeRecords(extensions),
    services: freezeRecords(services),
    contracts: freezeRecords(contracts),
    providers: freezeRecords(providers),
    selectedProviders: Object.freeze(selectedProviders),
    alternativeProviders: Object.freeze(alternativeProviders),
    health: snapshot.health ?? 'unknown',
    dependencies: Object.freeze(unique([
      ...(snapshot.dependencies ?? []),
      ...extensions.flatMap((extension) => extension.dependencies ?? []),
      ...services.flatMap((service) => service.dependencies ?? []),
      ...contracts.flatMap((contract) => contract.dependencies ?? []),
      ...providers.flatMap((provider) => provider.dependencies ?? []),
    ])),
    conflicts: Object.freeze(unique([
      ...(snapshot.conflicts ?? []),
      ...extensions.flatMap((extension) => extension.conflicts ?? []),
      ...services.flatMap((service) => service.conflicts ?? []),
      ...contracts.flatMap((contract) => contract.conflicts ?? []),
      ...providers.flatMap((provider) => provider.conflicts ?? []),
    ])),
    docs: Object.freeze(unique([...(snapshot.docs ?? []), ...extensions.flatMap((extension) => extension.docs ?? [])])),
    resources: Object.freeze(unique([...(snapshot.resources ?? []), ...extensions.flatMap((extension) => extension.resources ?? [])])),
    examples: Object.freeze(unique([...(snapshot.examples ?? []), ...extensions.flatMap((extension) => extension.examples ?? [])])),
    appServicesSnippet: snapshot.appServicesSnippet?.trim() || createAppServicesSnippet(snapshot.id, services, selectedProviders),
  });
}

export function toRuntimeCompositionCatalogEntry(
  snapshot: RuntimeCompositionSnapshot,
): RuntimeCatalogEntry {
  const document = toRuntimeCompositionCatalogDocument(snapshot);
  // Searchable identity terms only — method payload schemas stay readable through
  // this entry's resource_read action instead of being flattened into the
  // description, where their JSON made the entry match nearly every query.
  const searchable = unique([
    document.id,
    document.title,
    document.type,
    ...document.extensions.flatMap((extension) => [extension.id, extension.name ?? '', extension.description ?? '']),
    ...document.services.flatMap((service) => [
      service.id, service.publicName ?? '', service.name ?? '', service.description ?? '',
      ...Object.keys(service.methods ?? {}),
    ]),
    ...document.contracts.flatMap((contract) => [
      contract.id, contract.publicName ?? '', contract.name ?? '', contract.description ?? '',
      ...Object.keys(contract.methods ?? {}),
    ]),
    ...document.selectedProviders,
    ...document.alternativeProviders,
  ]);
  return {
    id: compositionCatalogId(document),
    kind: 'resource',
    title: document.title,
    description: unique([document.description, ...searchable]).join(' '),
    tags: Object.freeze(unique([
      'composition',
      'documentation',
      'extension',
      'service',
      'contract',
      document.type,
      document.health,
      ...document.extensions.flatMap((extension) => extension.type ? [extension.type] : []),
    ])),
    action: { type: 'resource_read', uri: compositionResourceUri(document.id) },
    // The full composition document (declarations, method schemas) is read back
    // through the action's resource_read uri; the entry itself stays a bounded
    // identity projection so catalog listings do not carry the whole document.
    metadata: Object.freeze({
      ...snapshot.metadata,
      extensionIdentity: document.extensions.map(identity),
      serviceIdentity: document.services.map(identity),
      contractIdentity: document.contracts.map(identity),
      selectedProviders: document.selectedProviders,
      alternativeProviders: document.alternativeProviders,
      health: document.health,
      dependencies: document.dependencies,
      conflicts: document.conflicts,
      docs: document.docs,
      resources: document.resources,
      examples: document.examples,
      appServicesSnippet: document.appServicesSnippet,
    }),
  };
}

async function readSnapshot(
  source: RuntimeCompositionSnapshotSource,
  _context: InvocationContext,
): Promise<RuntimeCompositionSnapshot> {
  return typeof source === 'function' ? source() : source;
}

function compositionCatalogId(document: Pick<RuntimeCompositionCatalogDocument, 'id'>): string {
  return `catalog://${PROVIDER_ID}/${encodeURIComponent(document.id)}`;
}

function compositionResourceUri(compositionId: string): string {
  return `${COMPOSITION_RESOURCE_URI_PREFIX}${encodeURIComponent(compositionId)}`;
}

function createAppServicesSnippet(
  compositionId: string,
  services: readonly RuntimeCompositionServiceSnapshot[],
  selectedProviders: readonly string[],
): string {
  const activeServices = services.filter((service) =>
    service.selectedProvider !== undefined
    || (service.publicName !== undefined && selectedProviders.includes(service.publicName)));
  return [
    `import { AppServices } from 'marshal:app-services';`,
    '',
    `// Active services in the ${JSON.stringify(compositionId)} composition:`,
    ...activeServices.map((service) =>
      service.publicName !== undefined
        ? `AppServices.get${capitalize(service.publicName)}();`
        : `AppServices.get(Symbol.for(${JSON.stringify(service.id)}));`),
  ].join('\n');
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function identity(value: RuntimeCompositionIdentity): RuntimeCompositionIdentity {
  return Object.freeze({
    id: value.id,
    name: value.name,
    version: value.version,
    description: value.description,
    type: value.type,
    packageLocation: value.packageLocation,
  });
}

function freezeRecords<T extends object>(values: readonly T[]): readonly T[] {
  return Object.freeze(values.map((value) => Object.freeze({ ...value })));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function requireText(value: string, label: string): string {
  if (!value?.trim()) throw new TypeError(`Runtime ${label} must be non-empty.`);
  return value.trim();
}
