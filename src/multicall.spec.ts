import { Contract } from '@ethersproject/contracts'
import { StaticJsonRpcProvider } from '@ethersproject/providers'
import { abi as IUniswapV3PoolABI } from '@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json'
import { abi as ITickLensABI } from '@uniswap/v3-periphery/artifacts/contracts/interfaces/ITickLens.sol/ITickLens.json'
// import { ITickLens, IUniswapV3Pool } from '../../uniswapV3/src/contracts'
import { MulticallProvider } from './index'

if (!process.env.PROVIDER_URL) throw new Error('env PROVIDER_URL is not set')

// provider
const _provider = new StaticJsonRpcProvider(process.env.PROVIDER_URL)
const defaultMulticallProvider = new MulticallProvider(_provider)

// init uniswap v3 service
const _poolContract = new Contract(
  '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8',
  IUniswapV3PoolABI,
) // as IUniswapV3Pool FIXME: put back the type
const defaultPoolContract = _poolContract.connect(defaultMulticallProvider)

const tickLensContract = new Contract(
  '0xbfd8137f7d1516D3ea5cA83523914859ec47F573',
  ITickLensABI,
) // as ITickLens FIXME: put back the type

const tickSpacing = 60

describe('Multicall Provider', () => {
  test('should execute 100 calls', async () => {
    const results = await Promise.all(
      new Array(100)
        .fill(true)
        .map((_, index) => defaultPoolContract.ticks(index * tickSpacing)),
    )
    expect(results.length).toBe(100)
    results.forEach((result) => {
      expect(result.liquidityGross).toBeTruthy()
    })
  }, 60000)

  test('should execute 100 calls with different blocks', async () => {
    const results = await Promise.all(
      new Array(100).fill(true).map((_, index) =>
        defaultPoolContract.ticks(index * tickSpacing, {
          blockTag: index < 30 || index > 80 ? 'latest' : 13192040,
        }),
      ),
    )
    expect(results.length).toBe(100)
    results.forEach((result) => {
      expect(result.liquidityGross).toBeTruthy()
    })
  }, 60000)

  test('should not throw any error', async () => {
    const results = await defaultPoolContract.snapshotCumulativesInside(
      194760,
      194820,
    )
    expect(results).toBeTruthy()
  }, 60000)

  test('should throw specific error for the failed calls', async () => {
    const fullErrorMulticallProvider = new MulticallProvider(_provider, {
      debugError: true,
    })
    const fullErrorPoolContract = _poolContract.connect(
      fullErrorMulticallProvider,
    )
    const results = await Promise.all([
      fullErrorPoolContract
        .snapshotCumulativesInside(194760, 194820)
        .catch((error) => error),
      fullErrorPoolContract
        .snapshotCumulativesInside(194820, 194760)
        .catch((error) => error),
    ])
    expect(results.length).toBe(2)
    expect(results[0]).not.toBeInstanceOf(Error)
    expect(results[1]).toBeInstanceOf(Error)
    expect(results[1].message).toContain('reason="TLU"')
  }, 60000)

  test('should throw generic error when using default config', async () => {
    const result = await defaultPoolContract
      .snapshotCumulativesInside(194820, 194760)
      .catch((error) => error)
    expect(result).toBeInstanceOf(Error)
    expect(result.message).toContain('an error occurred in a call')
  }, 60000)

  test('can be configured with (wrong) smart contract address', async () => {
    const wrongConfigMulticallProvider = new MulticallProvider(_provider, {
      smartContractAddress: '0x0000000000000000000000000000000000000000',
    })
    const wrongConfigPoolContract = _poolContract.connect(
      wrongConfigMulticallProvider,
    )
    const results = await wrongConfigPoolContract
      .snapshotCumulativesInside(194760, 194820)
      .catch((error) => error)
    expect(results).toBeInstanceOf(Error)
    expect(results.message).toContain('call revert exception')
  }, 60000)

  test(
    'should recover on timeout and server errors',
    async () => {
      const nbrCalls = 10000
      const timeoutMulticallProvider = new MulticallProvider(_provider, {
        recoverBatchError: true,
        maxBatchSize: Infinity,
      })
      const timeoutTickLensContract = tickLensContract.connect(
        timeoutMulticallProvider,
      )
      const results = await Promise.all(
        new Array(nbrCalls)
          .fill(true)
          .map((_, index) =>
            timeoutTickLensContract
              .getPopulatedTicksInWord(
                '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8',
                index,
              )
              .catch((error) => error),
          ),
      )
      expect(results.length).toBe(nbrCalls)
      results.forEach((result) => {
        expect(result).not.toBeInstanceOf(Error)
      })
    },
    60000 * 3,
  )
})
