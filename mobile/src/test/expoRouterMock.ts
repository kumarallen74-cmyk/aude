/** Shared expo-router mock for screen tests: params are set per test with setParams(). */
let params: Record<string, string> = {};
export const setParams = (p: Record<string, string>) => {
  params = p;
};
export const router = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn(), canGoBack: jest.fn(() => true) };
export const useLocalSearchParams = () => params;
export const Redirect = ({ href }: { href: string }) => {
  router.replace(href);
  return null;
};
export const Link = ({ children }: { children: unknown }) => children;
