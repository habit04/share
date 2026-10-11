import type { WindowsAzureSigningConfiguration, WindowsConfiguration } from 'app-builder-lib';

export function configureWindowsAzureSigning(win: WindowsConfiguration & { publisherName?: unknown }, signing: WindowsAzureSigningConfiguration): WindowsConfiguration;
