export async function httpFunction(url, options) {
    const request = new Request(url, Object.assign({ credentials: "include" }, options));
    const response = await fetch(request);
    if (!response.ok)
        throw new Error(`HTTP ${response.status}`);
    return response.json();
}
//# sourceMappingURL=general_functions.js.map