/**
 * Cloudflare Workers Docker 镜像代理服务
 * 
 * 这个服务作为各种 Docker 镜像仓库的代理，解决国内访问 Docker Hub 等仓库速度慢的问题
 * 支持多种镜像仓库：Docker Hub、Quay.io、GCR、GitHub Container Registry 等
 */

// 监听 fetch 事件，这是 Cloudflare Workers 的入口点
addEventListener("fetch", (event) => {
  // 当发生异常时，让请求直接穿透到源站而不是返回错误
  event.passThroughOnException();
  // 用自定义的 handleRequest 函数处理所有请求
  event.respondWith(handleRequest(event.request));
});

// Docker Hub 官方镜像仓库地址
const dockerHub = "https://registry-1.docker.io";

// 路由映射表：将不同的子域名映射到对应的镜像仓库
const routes = {
  // 生产环境路由
  ["docker." + CUSTOM_DOMAIN]: dockerHub,                        // Docker Hub 代理
  ["quay." + CUSTOM_DOMAIN]: "https://quay.io",                  // Red Hat Quay.io 代理
  ["gcr." + CUSTOM_DOMAIN]: "https://gcr.io",                    // Google Container Registry 代理
  ["k8s-gcr." + CUSTOM_DOMAIN]: "https://k8s.gcr.io",            // Kubernetes GCR 代理
  ["k8s." + CUSTOM_DOMAIN]: "https://registry.k8s.io",           // Kubernetes 官方镜像仓库代理
  ["ghcr." + CUSTOM_DOMAIN]: "https://ghcr.io",                  // GitHub Container Registry 代理
  ["cloudsmith." + CUSTOM_DOMAIN]: "https://docker.cloudsmith.io", // Cloudsmith 代理
  ["ecr." + CUSTOM_DOMAIN]: "https://public.ecr.aws",            // AWS Elastic Container Registry 公共仓库代理

  // 暂存环境路由
  ["docker-staging." + CUSTOM_DOMAIN]: dockerHub,                // Docker Hub 暂存环境代理
};

/**
 * 根据主机名路由到对应的上游服务器
 * @param {string} host - 请求的主机名
 * @returns {string} 对应的上游服务器 URL，如果没有匹配则返回空字符串
 */
function routeByHosts(host) {
  // 检查主机名是否在路由表中
  if (host in routes) {
    return routes[host];
  }
  // 如果是调试模式且没有匹配的路由，使用配置的目标上游服务器
  if (MODE == "debug") {
    return TARGET_UPSTREAM;
  }
  // 没有匹配的路由，返回空字符串
  return "";
}

/**
 * 处理所有传入的 HTTP 请求
 * @param {Request} request - 原始请求对象
 * @returns {Response} 处理后的响应对象
 */
async function handleRequest(request) {
  const url = new URL(request.url);
  
  // 如果访问根路径，重定向到 /v2/ (Docker Registry API v2 入口)
  if (url.pathname == "/") {
    return Response.redirect(url.protocol + "//" + url.host + "/v2/", 301);
  }
  
  // 根据主机名获取对应的上游服务器
  const upstream = routeByHosts(url.hostname);
  
  // 如果没有匹配的上游服务器，返回 404 并显示可用的路由
  if (upstream === "") {
    return new Response(
      JSON.stringify({
        routes: routes,
      }),
      {
        status: 404,
      }
    );
  }
  
  // 判断是否为 Docker Hub，因为 Docker Hub 需要特殊处理
  const isDockerHub = upstream == dockerHub;
  // 获取请求中的授权头
  const authorization = request.headers.get("Authorization");
  
  // 处理 Docker Registry API v2 根路径请求 (用于检查 API 版本支持)
  if (url.pathname == "/v2/") {
    const newUrl = new URL(upstream + "/v2/");
    const headers = new Headers();
    if (authorization) {
      headers.set("Authorization", authorization);
    }
    
    // 检查是否需要认证
    const resp = await fetch(newUrl.toString(), {
      method: "GET",
      headers: headers,
      redirect: "follow",
    });
    
    // 如果返回 401 未授权，返回认证质询
    if (resp.status === 401) {
      return responseUnauthorized(url);
    }
    return resp;
  }
  
  // 处理认证请求 (/v2/auth 端点用于获取 JWT token)
  if (url.pathname == "/v2/auth") {
    const newUrl = new URL(upstream + "/v2/");
    
    // 先请求上游服务器获取认证质询信息
    const resp = await fetch(newUrl.toString(), {
      method: "GET",
      redirect: "follow",
    });
    
    // 如果不需要认证，直接返回响应
    if (resp.status !== 401) {
      return resp;
    }
    
    // 解析 WWW-Authenticate 头获取认证服务器信息
    const authenticateStr = resp.headers.get("WWW-Authenticate");
    if (authenticateStr === null) {
      return resp;
    }
    
    const wwwAuthenticate = parseAuthenticate(authenticateStr);
    let scope = url.searchParams.get("scope");
    
    // 为 Docker Hub 的 library 镜像自动补全 scope
    // 例如：repository:busybox:pull => repository:library/busybox:pull
    if (scope && isDockerHub) {
      let scopeParts = scope.split(":");
      if (scopeParts.length == 3 && !scopeParts[1].includes("/")) {
        scopeParts[1] = "library/" + scopeParts[1];
        scope = scopeParts.join(":");
      }
    }
    
    // 获取 JWT token
    return await fetchToken(wwwAuthenticate, scope, authorization);
  }
  
  // 为 Docker Hub 的 library 镜像处理路径重定向
  // 例如：/v2/busybox/manifests/latest => /v2/library/busybox/manifests/latest
  if (isDockerHub) {
    const pathParts = url.pathname.split("/");
    // 检查是否为标准的 4 段路径格式（/v2/image/manifests/tag 或 /v2/image/blobs/digest）
    if (pathParts.length == 5) {
      // 在镜像名前插入 "library" 前缀
      pathParts.splice(2, 0, "library");
      const redirectUrl = new URL(url);
      redirectUrl.pathname = pathParts.join("/");
      return Response.redirect(redirectUrl, 301);
    }
  }
  
  // 转发请求到上游服务器
  const newUrl = new URL(upstream + url.pathname);
  const newReq = new Request(newUrl, {
    method: request.method,
    headers: request.headers,
    // 对于 Docker Hub，手动处理重定向以正确处理 blob 下载
    redirect: isDockerHub ? "manual" : "follow",
  });
  
  const resp = await fetch(newReq);
  
  // 如果返回 401 未授权，返回认证质询
  if (resp.status == 401) {
    return responseUnauthorized(url);
  }
  
  // 手动处理 Docker Hub の blob 重定向
  // Docker Hub 会将 blob 请求重定向到 CDN，我们需要手动跟随这个重定向
  if (isDockerHub && resp.status == 307) {
    const location = new URL(resp.headers.get("Location"));
    const redirectResp = await fetch(location.toString(), {
      method: "GET",
      redirect: "follow",
    });
    return redirectResp;
  }
  
  return resp;
}

/**
 * 解析 WWW-Authenticate 头，提取认证服务器信息
 * @param {string} authenticateStr - WWW-Authenticate 头的值
 * @returns {Object} 包含 realm 和 service 的对象
 * 
 * 示例输入: Bearer realm="https://auth.ipv6.docker.com/token",service="registry.docker.io"
 * 输出: { realm: "https://auth.ipv6.docker.com/token", service: "registry.docker.io" }
 */
function parseAuthenticate(authenticateStr) {
  // 使用正则表达式匹配引号内的字符串
  // 匹配 =" 之后和 " 之前的所有字符
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  
  if (matches == null || matches.length < 2) {
    throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
  }
  
  return {
    realm: matches[0],    // 认证服务器地址
    service: matches[1],  // 服务名称
  };
}

/**
 * 从认证服务器获取 JWT token
 * @param {Object} wwwAuthenticate - 包含认证服务器信息的对象
 * @param {string} scope - 请求的权限范围
 * @param {string} authorization - 用户认证信息
 * @returns {Response} 包含 JWT token 的响应
 */
async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  
  // 设置服务名称参数
  if (wwwAuthenticate.service.length) {
    url.searchParams.set("service", wwwAuthenticate.service);
  }
  
  // 设置权限范围参数
  if (scope) {
    url.searchParams.set("scope", scope);
  }
  
  const headers = new Headers();
  // 如果有用户认证信息，添加到请求头中
  if (authorization) {
    headers.set("Authorization", authorization);
  }
  
  return await fetch(url, { method: "GET", headers: headers });
}

/**
 * 返回 401 未授权响应，包含正确的认证质询头
 * @param {URL} url - 原始请求的 URL 对象  
 * @returns {Response} 401 未授权响应
 */
function responseUnauthorized(url) {
  const headers = new Headers();
  
  // 根据运行模式设置不同的认证 realm
  if (MODE == "debug") {
    // 调试模式使用 HTTP 协议
    headers.set(
      "Www-Authenticate",
      `Bearer realm="http://${url.host}/v2/auth",service="cloudflare-docker-proxy"`
    );
  } else {
    // 生产模式使用 HTTPS 协议
    headers.set(
      "Www-Authenticate",
      `Bearer realm="https://${url.hostname}/v2/auth",service="cloudflare-docker-proxy"`
    );
  }
  
  return new Response(JSON.stringify({ message: "UNAUTHORIZED" }), {
    status: 401,
    headers: headers,
  });
}
