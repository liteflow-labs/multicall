import { BlockTag } from '@ethersproject/abstract-provider'
import { Contract } from '@ethersproject/contracts'
import { ErrorCode } from '@ethersproject/logger'
import { Networkish } from '@ethersproject/networks'
import { StaticJsonRpcProvider } from '@ethersproject/providers'
import DataLoader from 'dataloader'
import { ConnectionInfo } from 'ethers/lib/utils'
import multicallAbi from './abi/multicall2.json'
import { Multicall2 } from './contracts'

export interface MulticallProviderConfig {
  /**
   * Show debug logs
   * @default false
   **/
  verbose: boolean

  /**
   * Maximum size of a batch
   * @default 500
   **/
  maxBatchSize: number

  /**
   * If set to true, failed calls will be re-executed without using multicall to get a better error message. Very useful in development
   * @default false
   **/
  debugError: boolean

  /**
   * Address of the multicall v2 smart contract
   * Check makerdao's multicall repo for other deployment: https://github.com/makerdao/multicall
   * @default 0x5ba1e12693dc8f9c48aad8770482f4739beed696
   **/
  smartContractAddress: string

  /**
   * Should it try to recover timeout and server error by retrying the call with half the number of calls
   * @default false
   **/
  recoverBatchError: boolean

  /**
   * Max number of time it tries to recover the batch error
   * @default 3
   **/
  maxRecoverDepth: number
}

const defaultConfig: MulticallProviderConfig = {
  verbose: false,
  maxBatchSize: 500,
  debugError: false,
  smartContractAddress: '0x5ba1e12693dc8f9c48aad8770482f4739beed696',
  recoverBatchError: false,
  maxRecoverDepth: 3,
}

interface JsonRpcError {
  code: string
  status: string
  reason: string
}

interface SendParams {
  to: string
  data: string
}

type Call = [SendParams, BlockTag]

export class MulticallProvider extends StaticJsonRpcProvider {
  // makerdao's multicall v2 smart contract: https://github.com/makerdao/multicall
  private readonly multicall: Multicall2

  private readonly config: MulticallProviderConfig

  private readonly dataloader: DataLoader<Call, any, string>

  constructor(
    url: ConnectionInfo | string,
    config?: Partial<MulticallProviderConfig>,
    network?: Networkish,
  ) {
    // init super
    super(url, network)

    // set config with default
    this.config = {
      ...defaultConfig,
      ...config,
      smartContractAddress:
        config?.smartContractAddress || defaultConfig.smartContractAddress, // force default if value is falsy
    }

    // init multicall contract
    this.multicall = new Contract(
      this.config.smartContractAddress,
      multicallAbi,
      this,
    ) as Multicall2

    // init dataloader
    this.dataloader = new DataLoader((calls) => this.multiCallSend(calls, 0), {
      cache: false,
      maxBatchSize: this.config.maxBatchSize,
    })
  }

  async send(method: string, params: Array<any>): Promise<any> {
    // multicall is only compatible with eth_call method
    if (method !== 'eth_call') return super.send(method, params)

    // multicall is only compatible with params to and data, nothing more
    const keys = Object.keys(params[0])
    if (
      keys.length !== 2 ||
      (!(keys[0] === 'to' && keys[1] === 'data') &&
        !(keys[0] === 'data' && keys[1] === 'to'))
    ) {
      if (this.config.verbose)
        console.debug(
          `call not multicalled because some params are not compatible: ${keys}`,
        )
      return super.send(method, params)
    }

    // do not multicall if the call is already to the multicall contract
    if (
      params[0].to.toLowerCase() ===
      this.config.smartContractAddress.toLowerCase()
    ) {
      return super.send(method, params)
    }

    // multicall it!
    return this.dataloader.load(params as Call)
  }

  private async multiCallSend(
    calls: readonly Call[],
    currentHalving: number,
  ): Promise<(string | Error | any)[]> {
    try {
      // group calls with same block but also keep the order of calls
      let lastBlockTag: BlockTag = 0 // dummy value
      let callsByBlockIndex = -1 // first iteration will increment this
      const callsByBlock: { blockTag: BlockTag; params: SendParams[] }[] = []
      for (const [params, blockTag] of calls) {
        // different block, change list
        if (lastBlockTag != blockTag) {
          lastBlockTag = blockTag
          callsByBlockIndex++
        }

        // make sure index exist
        if (!callsByBlock[callsByBlockIndex])
          callsByBlock[callsByBlockIndex] = { blockTag: blockTag, params: [] }

        // push params to list
        callsByBlock[callsByBlockIndex].params.push(params)
      }
      // execute the aggregate with calls of same blockTag
      const aggregationsPerBlock = await Promise.all(
        callsByBlock.map(({ blockTag, params }) =>
          this.multicall.callStatic.tryAggregate(
            false,
            params.map((param) => ({
              callData: param.data,
              target: param.to,
            })),
            { blockTag },
          ),
        ),
      )
      // flat aggregations
      const aggregation = aggregationsPerBlock.reduce((flat, aggr) =>
        flat.concat(aggr),
      )
      // process result
      return aggregation.map((result, index) => {
        if (result.success) return result.returnData
        if (this.config.debugError) {
          // in case of error, re-execute the call on the provider to get a better error message
          return super.send('eth_call', calls[index])
        }
        return new Error(
          `an error occurred in a call. To get the full error of failed calls, set config of multicall provider debugError to true`,
        )
      })
    } catch (error: any) {
      if (!error.error) throw error // unknown error
      if (!this.config.recoverBatchError) throw error // no recover of batch error
      if (currentHalving === this.config.maxRecoverDepth) {
        // already reach the max depth
        if (this.config.verbose)
          console.debug('max halving reached. throwing error')
        throw error
      }

      // check error code
      const errorJsonRpc = error.error as JsonRpcError
      if (
        errorJsonRpc.code !== ErrorCode.TIMEOUT &&
        errorJsonRpc.code !== ErrorCode.SERVER_ERROR
      ) {
        throw error
      }

      // cannot recover batch of only 1 call or less
      if (calls.length <= 1) throw error

      // try to recover error by splitting calls in two groups and try again
      if (this.config.verbose)
        console.debug('recovering batch calls with depth of', currentHalving)
      const half = Math.ceil(calls.length / 2)
      const results = await Promise.all([
        this.multiCallSend(calls.slice(0, half), currentHalving + 1),
        this.multiCallSend(calls.slice(half, calls.length), currentHalving + 1),
      ])
      return results[0].concat(results[1])
    }
  }
}
