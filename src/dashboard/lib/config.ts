declare const __DASHBOARD_CONFIG__: {
  appName: string;
  timezone: string;
  environment: string;
  defaultPlatformFeeBps: number;
};
export const dashboardConfig =
  typeof __DASHBOARD_CONFIG__ === 'undefined'
    ? {
        appName: 'Rampage',
        timezone: 'Asia/Manila',
        environment: 'test',
        defaultPlatformFeeBps: 500,
      }
    : __DASHBOARD_CONFIG__;
