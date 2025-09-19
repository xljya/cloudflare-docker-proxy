/**
 * Cloudflare Workers Docker Registry Proxy
 * 解决Docker Hub速率限制问题的高效代理
 */

// 路由配置 - 根据域名映射到不同的上游registry
const routes = {
  "docker.liucf.com": "https://registry-1.docker.io",
  "quay.liucf.com": "https://quay.io", 
  "gcr.liucf.com": "https://gcr.io",
  "k8s-gcr.liucf.com": "https://k8s.gcr.io",
  "k8s.liucf.com": "https://registry.k8s.io",
  "ghcr.liucf.com": "https://ghcr.io",
  "cloudsmith.liucf.com": "https://docker.cloudsmith.io",
  "ecr.liucf.com": "https://public.ecr.aws"
};

// Docker Hub认证服务映射
const authUrls = {
  "https://registry-1.docker.io": "https://auth.docker.io",
  "https://quay.io": "https://quay.io",
  "https://gcr.io": "https://gcr.io", 
  "https://k8s.gcr.io": "https://k8s.gcr.io",
  "https://registry.k8s.io": "https://registry.k8s.io",
  "https://ghcr.io": "https://ghcr.io"
};

// 主事件监听器
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

/**
 * 主请求处理函数
 */
async function handleRequest(request) {
  const url = new URL(request.url);
  const hostname = url.hostname;
  
  // 处理OPTIONS预检请求
  if (request.method === 'OPTIONS') {
    return handleOptions();
  }
  
  // 获取对应的上游registry
  const upstream = routes[hostname];
  if (!upstream) {
    return new Response(`Registry not configured for ${hostname}`, { 
      status: 404,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  // 路由请求到对应处理函数
  if (url.pathname === '/v2/') {
    return handleV2Check(request, upstream, hostname);
  } else if (url.pathname.startsWith('/v2/auth')) {
    return handleAuth(request, upstream, hostname);
  } else if (url.pathname.startsWith('/v2/')) {
    return handleRegistryRequest(request, upstream);
  } else {
    return new Response('Docker Registry API v2 only', { 
      status: 404,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

/**
 * 处理 /v2/ 检查请求 - Docker Registry API入口点
 */
async function handleV2Check(request, upstream, hostname) {
  // 返回401要求认证，这是Docker Registry API标准行为
  return new Response('', {
    status: 401,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Docker-Distribution-Api-Version': 'registry/2.0',
      'Www-Authenticate': `Bearer realm="https://${hostname}/v2/auth",service="cloudflare-docker-proxy"`,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type'
    }
  });
}

/**
 * 处理认证请求 - 关键函数，绕过Docker Hub速率限制
 */
async function handleAuth(request, upstream, hostname) {
  const url = new URL(request.url);
  const authUrl = authUrls[upstream];
  
  if (!authUrl) {
    return new Response('Auth service not available', { 
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }

  // 构建上游认证请求URL，重写service参数
  let authEndpoint;
  if (upstream === "https://registry-1.docker.io") {
    // Docker Hub使用/token端点，需要重写service参数
    const searchParams = new URLSearchParams(url.search);
    
    // 关键修复：确保service参数正确
    const originalService = searchParams.get('service');
    console.log(`Original service: ${originalService}`);
    
    // 无论客户端发送什么service，都重写为Docker Hub需要的值
    searchParams.set('service', 'registry.docker.io');
    
    // 确保scope参数存在
    if (!searchParams.has('scope')) {
      searchParams.set('scope', 'repository:library/alpine:pull');
    }
    
    authEndpoint = `${authUrl}/token?${searchParams.toString()}`;
    console.log(`Auth endpoint: ${authEndpoint}`);
  } else {
    // 其他registry可能使用不同的认证端点
    authEndpoint = `${authUrl}/v2/auth${url.search}`;
  }

  try {
    // 创建上游认证请求
    const authHeaders = new Headers();
    authHeaders.set('User-Agent', 'Docker/20.10.0 cloudflare-docker-proxy/1.0');
    authHeaders.set('Accept', 'application/json');
    
    // 转发原始请求的Authorization头（如果存在）
    const authHeader = request.headers.get('Authorization');
    if (authHeader) {
      authHeaders.set('Authorization', authHeader);
    }

    const authRequest = new Request(authEndpoint, {
      method: request.method,
      headers: authHeaders
    });

    console.log(`Auth request to: ${authEndpoint}`);
    const authResponse = await fetch(authRequest);
    
    console.log(`Auth response status: ${authResponse.status}`);
    const authData = await authResponse.text();
    console.log(`Auth response data length: ${authData.length}`);
    
    if (!authResponse.ok) {
      console.error(`Auth failed: ${authResponse.status} ${authResponse.statusText}`);
      console.error(`Auth error response: ${authData}`);
      
      // 对于认证失败，返回更详细的错误信息
      return new Response(authData || JSON.stringify({
        error: 'authentication_failed',
        message: `Upstream auth failed with status ${authResponse.status}`
      }), {
        status: authResponse.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 验证并可能修改响应
    let tokenData;
    try {
      tokenData = JSON.parse(authData);
      if (!tokenData.token && !tokenData.access_token) {
        console.error('No token found in auth response');
        return new Response(JSON.stringify({
          error: 'no_token',
          message: 'Authentication response does not contain a valid token'
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
      
      // 重要：保持原始token不变，Docker客户端需要原始的Docker Hub token
      // 不修改token内容，因为它包含了正确的签名和权限
      console.log(`Token audience: ${tokenData.aud || 'not specified'}`);
      
    } catch (e) {
      console.error('Failed to parse auth response as JSON:', e);
      // 如果不是JSON，可能是纯文本token，直接返回
    }

    console.log(`Auth success: ${authResponse.status}, token present: ${!!(tokenData && (tokenData.token || tokenData.access_token))}`);
    
    return new Response(authData, {
      status: authResponse.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type'
      }
    });

  } catch (error) {
    console.error('Auth request error:', error);
    return new Response(JSON.stringify({ 
      error: 'auth_service_error',
      message: 'Failed to contact authentication service' 
    }), { 
      status: 500,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

/**
 * 处理registry请求（manifest, blob等）
 */
async function handleRegistryRequest(request, upstream) {
  const url = new URL(request.url);
  const upstreamUrl = `${upstream}${url.pathname}${url.search}`;

  // 复制并清理请求头
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey !== 'host' && lowerKey !== 'cf-ray' && lowerKey !== 'cf-connecting-ip') {
      headers.set(key, value);
    }
  }
  
  // 设置合适的User-Agent
  headers.set('User-Agent', 'Docker/20.10.0 cloudflare-docker-proxy/1.0');

  try {
    const upstreamRequest = new Request(upstreamUrl, {
      method: request.method,
      headers: headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : null
    });

    console.log(`Registry request: ${request.method} ${upstreamUrl}`);
    const upstreamResponse = await fetch(upstreamRequest);

    // 处理重定向到CDN
    if (upstreamResponse.status >= 300 && upstreamResponse.status < 400) {
      const location = upstreamResponse.headers.get('Location');
      if (location) {
        console.log(`Redirecting to: ${location}`);
        return new Response(null, {
          status: upstreamResponse.status,
          headers: upstreamResponse.headers
        });
      }
    }

    // 复制响应头
    const responseHeaders = new Headers();
    for (const [key, value] of upstreamResponse.headers.entries()) {
      const lowerKey = key.toLowerCase();
      
      // 重写WWW-Authenticate头，确保Docker客户端使用我们的代理认证
      if (lowerKey === 'www-authenticate' && upstreamResponse.status === 401) {
        const hostname = new URL(request.url).hostname;
        const originalAuth = value;
        console.log(`Original WWW-Authenticate: ${originalAuth}`);
        
        // 关键修复：不在WWW-Authenticate头中包含scope
        // Docker客户端会自动根据请求的资源生成scope参数
        const newAuth = `Bearer realm="https://${hostname}/v2/auth",service="cloudflare-docker-proxy"`;
        console.log(`New WWW-Authenticate: ${newAuth}`);
        
        responseHeaders.set('Www-Authenticate', newAuth);
      } else {
        responseHeaders.set(key, value);
      }
    }
    
    // 添加CORS头
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Docker-Content-Digest');

    console.log(`Registry response: ${upstreamResponse.status}`);
    
    // 对于401响应，确保返回标准的Docker错误格式
    if (upstreamResponse.status === 401) {
      const errorBody = JSON.stringify({
        errors: [{
          code: "UNAUTHORIZED",
          message: "authentication required",
          detail: [{
            Type: "repository",
            Class: "",
            Name: url.pathname.replace(/^\/v2\//, '').replace(/\/manifests\/.*$/, '').replace(/\/blobs\/.*$/, ''),
            Action: "pull"
          }]
        }]
      });
      
      return new Response(errorBody, {
        status: upstreamResponse.status,
        headers: responseHeaders
      });
    }
    
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders
    });

  } catch (error) {
    console.error('Registry request error:', error);
    return new Response(JSON.stringify({
      error: 'registry_error',
      message: 'Failed to contact upstream registry'
    }), { 
      status: 502,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

/**
 * 处理OPTIONS预检请求
 */
function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Docker-Content-Digest',
      'Access-Control-Max-Age': '86400'
    }
  });
}