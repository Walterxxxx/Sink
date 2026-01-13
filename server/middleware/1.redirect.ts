import type { LinkSchema } from '@@/schemas/link'
import type { z } from 'zod'
import { getHeader, getRequestHost, getRequestProtocol } from 'h3'
import { parsePath, withQuery } from 'ufo'
import { useAccessLog } from '@/utils/access-log'

export default eventHandler(async (event) => {
  const { pathname: slug } = parsePath(event.path.replace(/^\/|\/$/g, '')) // remove leading and trailing slashes
  const { slugRegex, reserveSlug } = useAppConfig(event)
  const { homeURL, linkCacheTtl, redirectWithQuery, caseSensitive } = useRuntimeConfig(event)
  const { cloudflare } = event.context

  if (event.path === '/' && homeURL)
    return sendRedirect(event, homeURL)

  if (slug && !reserveSlug.includes(slug) && slugRegex.test(slug) && cloudflare) {
    const { KV } = cloudflare.env

    let link: z.infer<typeof LinkSchema> | null = null

    const getLink = async (key: string) =>
      await KV.get(`link:${key}`, { type: 'json', cacheTtl: linkCacheTtl })

    const lowerCaseSlug = slug.toLowerCase()
    link = await getLink(caseSensitive ? slug : lowerCaseSlug)

    // fallback to original slug if caseSensitive is false and the slug is not found
    if (!caseSensitive && !link && lowerCaseSlug !== slug) {
      console.log('original slug fallback:', `slug:${slug} lowerCaseSlug:${lowerCaseSlug}`)
      link = await getLink(slug)
    }

    if (link) {
      event.context.link = link
      try {
        await useAccessLog(event)
      }
      catch (error) {
        console.error('Failed write access log:', error)
      }

      const userAgent = getHeader(event, 'user-agent') || ''
      const isSocialMediaCrawler = userAgent.toLowerCase().includes('whatsapp')
        || userAgent.toLowerCase().includes('facebook')
        || userAgent.toLowerCase().includes('twitter')
        || userAgent.toLowerCase().includes('linkedin')
        || userAgent.toLowerCase().includes('slack')
        || userAgent.toLowerCase().includes('discord')
        || userAgent.toLowerCase().includes('telegram')
        || userAgent.toLowerCase().includes('pinterest')
        || userAgent.toLowerCase().includes('bot')
        || userAgent.toLowerCase().includes('crawler')
        || userAgent.toLowerCase().includes('spider')

      if (isSocialMediaCrawler) {
        // Return HTML with social media meta tags for crawlers
        const protocol = getRequestProtocol(event)
        const host = getRequestHost(event)
        const shortLink = `${protocol}://${host}/${link.slug}`

        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${link.title || 'Short Link'}</title>
  
  <!-- Open Graph / Facebook -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="${shortLink}">
  <meta property="og:title" content="${link.title || 'Short Link'}">
  <meta property="og:description" content="${link.description || ''}">
  ${link.image ? `<meta property="og:image" content="${link.image}">` : ''}
  
  <!-- Twitter -->
  <meta property="twitter:card" content="summary_large_image">
  <meta property="twitter:url" content="${shortLink}">
  <meta property="twitter:title" content="${link.title || 'Short Link'}">
  <meta property="twitter:description" content="${link.description || ''}">
  ${link.image ? `<meta property="twitter:image" content="${link.image}">` : ''}
  
  <!-- WhatsApp -->
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  
  <!-- Redirect after 1 second -->
  <meta http-equiv="refresh" content="1;url=${link.url}">
</head>
<body>
  <script>
    // JavaScript redirect for modern browsers
    window.location.href = '${link.url}';
  </script>
</body>
</html>
        `.trim()

        setHeader(event, 'Content-Type', 'text/html')
        return html
      }

      const target = redirectWithQuery ? withQuery(link.url, getQuery(event)) : link.url
      return sendRedirect(event, target, +useRuntimeConfig(event).redirectStatusCode)
    }
  }
})
