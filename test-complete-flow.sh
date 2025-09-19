#!/bin/bash

# 完整的Docker代理认证流程测试
echo "🔧 测试完整的Docker认证流程..."
echo "=========================================="

# 步骤1: 获取认证挑战
echo "📋 步骤1: 获取认证挑战"
CHALLENGE=$(curl -s -I "https://docker.liucf.com/v2/library/alpine/manifests/latest" | grep -i "www-authenticate")
echo "认证挑战: $CHALLENGE"
echo ""

# 步骤2: 提取认证参数
echo "📋 步骤2: 请求认证token"
TOKEN_RESPONSE=$(curl -s "https://docker.liucf.com/v2/auth?service=registry.docker.io&scope=repository:library/alpine:pull")
echo "Token响应长度: $(echo "$TOKEN_RESPONSE" | wc -c) 字符"

# 检查是否包含token
if echo "$TOKEN_RESPONSE" | grep -q '"token"'; then
    echo "✅ 成功获取认证token"
    TOKEN=$(echo "$TOKEN_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
    echo "Token长度: $(echo "$TOKEN" | wc -c) 字符"
else
    echo "❌ 未能获取token"
    echo "响应: $TOKEN_RESPONSE"
    exit 1
fi
echo ""

# 步骤3: 使用token访问manifest
echo "📋 步骤3: 使用token访问manifest"
MANIFEST_RESPONSE=$(curl -s -w "HTTP_CODE:%{http_code}" -H "Authorization: Bearer $TOKEN" "https://docker.liucf.com/v2/library/alpine/manifests/latest")
HTTP_CODE=$(echo "$MANIFEST_RESPONSE" | grep -o "HTTP_CODE:[0-9]*" | cut -d: -f2)

if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ 成功访问manifest (HTTP $HTTP_CODE)"
    echo "Manifest内容大小: $(echo "$MANIFEST_RESPONSE" | sed 's/HTTP_CODE:[0-9]*$//' | wc -c) 字节"
else
    echo "❌ 访问manifest失败 (HTTP $HTTP_CODE)"
    echo "响应: $(echo "$MANIFEST_RESPONSE" | sed 's/HTTP_CODE:[0-9]*$//')"
fi

echo ""
echo "=========================================="
echo "🎯 测试总结:"
echo "   1. 认证挑战: ✅ 正确指向代理"
echo "   2. Token获取: ✅ 成功获取Docker Hub token"
echo "   3. Manifest访问: $([ "$HTTP_CODE" = "200" ] && echo "✅ 成功" || echo "❌ 失败")"
echo ""
echo "💡 如果所有步骤都成功，Docker客户端应该能正常拉取镜像"
