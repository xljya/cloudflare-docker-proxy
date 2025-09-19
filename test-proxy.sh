#!/bin/bash

# Docker代理测试脚本 - 解决速率限制问题
# 用于测试Cloudflare Workers Docker代理是否正常工作

echo "🚀 开始测试 Docker 代理功能 - 解决速率限制..."
echo "=========================================="

# 测试1: 检查 /v2/ 端点
echo "📋 测试1: 检查 Docker Registry API v2 端点"
echo "curl -I https://docker.liucf.com/v2/"
curl -I https://docker.liucf.com/v2/
echo ""

# 测试2: 检查认证端点 - 关键测试
echo "📋 测试2: 检查认证端点（绕过速率限制的关键）"
echo "curl -s 'https://docker.liucf.com/v2/auth?service=cloudflare-docker-proxy&scope=repository:library/alpine:pull' | jq ."
AUTH_RESPONSE=$(curl -s "https://docker.liucf.com/v2/auth?service=cloudflare-docker-proxy&scope=repository:library/alpine:pull")
echo "$AUTH_RESPONSE"
echo ""

# 检查是否成功获取token
if echo "$AUTH_RESPONSE" | grep -q "token"; then
    echo "✅ 认证成功 - 已获取访问token"
else
    echo "❌ 认证失败 - 未获取到token"
    echo "这可能导致速率限制问题"
fi
echo ""

# 测试3: 尝试拉取镜像
echo "📋 测试3: 尝试拉取 Alpine 镜像（测试速率限制修复）"
echo "docker pull docker.liucf.com/library/alpine:latest"
docker pull docker.liucf.com/library/alpine:latest

echo ""
echo "=========================================="
echo "✅ 测试完成！"
echo ""
echo "💡 如果拉取成功，说明速率限制问题已解决"
echo "💡 如果仍然出现速率限制错误，请检查："
echo "   1. Worker是否已正确部署"
echo "   2. DNS解析是否指向Cloudflare"
echo "   3. 路由配置是否正确"
echo ""
echo "🔧 手动部署命令："
echo "   wrangler deploy --env production"
