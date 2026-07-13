import type {
  ChannelTestAllResponse,
  ChannelTestRequest,
  ChannelTestResponse,
} from '../types'

export function channelTestSuccessContractError(
  response: ChannelTestResponse,
  request: ChannelTestRequest = {}
): string | undefined {
  if (!response.success) return undefined

  const data = response.data
  if (!data) return 'Channel test response is missing probe evidence.'

  const { requested, effective, validation } = data
  if (
    !requested ||
    typeof requested.model !== 'string' ||
    typeof requested.endpoint_type !== 'string' ||
    typeof requested.stream !== 'boolean'
  ) {
    return 'Channel test response has invalid requested probe evidence.'
  }
  if (
    !effective ||
    typeof effective.model !== 'string' ||
    typeof effective.endpoint_type !== 'string' ||
    (effective.endpoint_type as string) === 'auto' ||
    typeof effective.route !== 'string' ||
    typeof effective.stream !== 'boolean' ||
    typeof effective.transport !== 'string' ||
    effective.transport.length === 0
  ) {
    return 'Channel test response has invalid effective probe evidence.'
  }
  if (
    !validation ||
    (validation.mode !== 'json' && validation.mode !== 'sse') ||
    typeof validation.content_type !== 'string' ||
    validation.content_type.length === 0 ||
    typeof validation.response_validated !== 'boolean'
  ) {
    return 'Channel test response has invalid validation evidence.'
  }
  if (
    data.response_time !== undefined &&
    (typeof data.response_time !== 'number' ||
      !Number.isFinite(data.response_time) ||
      data.response_time < 0)
  ) {
    return 'Channel test response has invalid latency evidence.'
  }

  const expectedEndpoint = request.endpoint_type ?? 'auto'
  const expectedStream = request.stream === true
  if (requested.endpoint_type !== expectedEndpoint) {
    return 'Channel test endpoint acknowledgement does not match the request.'
  }
  if (requested.stream !== expectedStream) {
    return 'Channel test stream acknowledgement does not match the request.'
  }
  if (request.model && requested.model !== request.model) {
    return 'Channel test model acknowledgement does not match the request.'
  }
  if (effective.stream !== expectedStream) {
    return 'Channel test effective stream mode does not match the request.'
  }
  if (!effective.route.startsWith('/')) {
    return 'Channel test response is missing an effective relay route.'
  }
  if (validation.response_validated !== true) {
    return 'Channel test upstream response was not validated.'
  }
  if (validation.mode !== (expectedStream ? 'sse' : 'json')) {
    return 'Channel test validation mode does not match the request.'
  }
  return undefined
}

export function channelTestAllContractValid(
  response: ChannelTestAllResponse
): boolean {
  const data = response.data
  if (!response.success || !data) return false
  const counts = [
    data.attempted,
    data.succeeded,
    data.failed,
    data.skipped,
    data.max_channels,
  ]
  return (
    counts.every((value) => Number.isInteger(value) && value >= 0) &&
    data.succeeded + data.failed === data.attempted &&
    data.attempted <= data.max_channels
  )
}
