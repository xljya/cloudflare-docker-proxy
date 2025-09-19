#!/bin/bash

# Docker 认证问题完整修复脚本
echo "🔧 Docker 认证问题诊断和修复"
echo "=========================================="

# 步骤1: 清理Docker认证缓存
echo "📋 步骤1: 清理Docker认证缓存"
echo "执行以下命令清理Docker缓存:"
echo "docker system prune -f"
echo "rm -rf ~/.docker/config.json"
echo "systemctl restart docker"
echo ""

# 步骤2: 测试代理认证流程
echo "📋 步骤2: 测试代理认证流程"

# 测试认证端点
echo "测试认证端点..."
AUTH_URL="https://docker.liucf.com/v2/auth?service=cloudflare-docker-proxy&scope=repository:library/alpine:pull"
TOKEN_RESPONSE=$(curl -s "$AUTH_URL")

if echo "$TOKEN_RESPONSE" | grep -q '"token"'; then
    echo "✅ 认证端点正常 - 成功获取token"
    TOKEN=$(echo "$TOKEN_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
    echo "Token长度: $(echo "$TOKEN" | wc -c) 字符"
else
    echo "❌ 认证端点异常"
    echo "响应: $TOKEN_RESPONSE"
    exit 1
fi

# 测试使用token访问manifest
echo ""
echo "测试使用token访问manifest..."
MANIFEST_URL="https://docker.liucf.com/v2/library/alpine/manifests/latest"
MANIFEST_RESPONSE=$(curl -s -w "HTTP_CODE:%{http_code}" -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.docker.distribution.manifest.v2+json" "$MANIFEST_URL")
HTTP_CODE=$(echo "$MANIFEST_RESPONSE" | grep -o "HTTP_CODE:[0-9]*" | cut -d: -f2)

if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Token验证成功 (HTTP $HTTP_CODE)"
else
    echo "❌ Token验证失败 (HTTP $HTTP_CODE)"
    echo "响应: $(echo "$MANIFEST_RESPONSE" | sed 's/HTTP_CODE:[0-9]*$//')"
fi

echo ""
echo "=========================================="
echo "🎯 修复建议:"
echo ""
echo "如果上述测试都成功，但docker pull仍然失败，请尝试:"
echo ""
echo "1. 清理Docker缓存和重启:"
echo "   docker system prune -f"
echo "   rm -rf ~/.docker/config.json"
echo "   systemctl restart docker"
echo ""
echo "2. 尝试不同的拉取方式:"
echo "   docker pull --disable-content-trust docker.liucf.com/library/alpine:latest"
echo ""
echo "3. 检查Docker daemon配置:"
echo "   cat /etc/docker/daemon.json"
echo ""
echo "4. 查看详细的Docker日志:"
echo "   docker pull docker.liucf.com/library/alpine:latest -D"
echo ""
echo "5. 如果仍然失败，可能是Docker版本兼容性问题，尝试:"
echo "   export DOCKER_BUILDKIT=0"
echo "   docker pull docker.liucf.com/library/alpine:latest"
echo ""
echo "💡 代理本身工作正常，问题可能在Docker客户端配置"
