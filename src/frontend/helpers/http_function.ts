export async function httpFunction<T = any>(
  url: string,
  options?: RequestInit
): Promise<T> {
  const request = new Request(url, {
    credentials: "include",
    ...options,
  });

  const response = await fetch(request);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
